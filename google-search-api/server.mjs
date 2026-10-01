import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || "30", 10);

function loadApiKeys() {
  const keys = new Map();
  if (process.env.API_KEYS) {
    for (const part of process.env.API_KEYS.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(":");
      if (idx <= 0 || idx === trimmed.length - 1) {
        throw new Error(`Invalid API_KEYS entry: "${trimmed}" must be label:key`);
      }
      keys.set(trimmed.slice(idx + 1), trimmed.slice(0, idx));
    }
  } else if (process.env.API_KEY) {
    keys.set(process.env.API_KEY, "default");
  }
  return keys;
}

const apiKeys = loadApiKeys();
const MAX_CONCURRENCY = parseInt(process.env.SEARCH_CONCURRENCY || "2", 10);
const MAX_TIMEOUT = parseInt(process.env.MAX_TIMEOUT || "120000", 10);

const MODULE_DIR = path.resolve(
  process.env.GOOGLE_SEARCH_DIR ||
  fileURLToPath(new URL("../google-search", import.meta.url))
);

const [{ googleSearch, getGoogleSearchPageHtml }, { chromium }, { default: logger }] =
  await Promise.all([
    import(pathToFileURL(path.join(MODULE_DIR, "dist/src/search.js")).href),
    import(
      pathToFileURL(path.join(MODULE_DIR, "node_modules/playwright/index.mjs")).href
    ),
    import(pathToFileURL(path.join(MODULE_DIR, "dist/src/logger.js")).href),
  ]);

const stateFilePath =
  process.env.STATE_FILE ||
  path.join(os.homedir(), ".google-search-browser-state.json");

let globalBrowser;

let activeCount = 0;
const waitQueue = [];

async function withSlot(fn) {
  if (activeCount >= MAX_CONCURRENCY) {
    await new Promise((resolve) => waitQueue.push(resolve));
  }
  activeCount++;
  try {
    return await fn();
  } finally {
    activeCount--;
    const next = waitQueue.shift();
    if (next) next();
  }
}

function clampInt(value, min, max, fallback) {
  const parsed = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isFailureResult(result) {
  return (
    Array.isArray(result.results) &&
    result.results.length === 1 &&
    result.results[0].title === "搜索失败" &&
    result.results[0].link === ""
  );
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1000000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendHtml(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const swaggerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Google Search API - Swagger UI</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<div id="fallback" style="display:none;font-family:system-ui,sans-serif;max-width:720px;margin:3rem auto;padding:0 1rem">
  <h2>Swagger UI could not load</h2>
  <p>The CDN (unpkg.com) is unreachable from this browser. The raw OpenAPI spec is always available at <a href="/openapi.json">/openapi.json</a>.</p>
</div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
window.onload = function () {
  if (typeof SwaggerUIBundle === "undefined") {
    document.getElementById("fallback").style.display = "block";
    return;
  }
  window.ui = SwaggerUIBundle({
    url: "/openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    tryItOutEnabled: true,
    presets: [SwaggerUIBundle.presets.apis]
  });
};
</script>
</body>
</html>`;

const searchResponses = {
  200: {
    description: "Search results",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/SearchResponse" },
      },
    },
  },
  400: {
    description: "Missing query",
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/Error" } },
    },
  },
  401: {
    description: "Invalid or missing API key",
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/Error" } },
    },
  },
  500: {
    description: "Internal error",
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/Error" } },
    },
  },
  502: {
    description: "Search failed (e.g. Google CAPTCHA escalation, network error). The error field carries the underlying message.",
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/Error" } },
    },
  },
  429: {
    description: "Rate limit exceeded for this API key (RATE_LIMIT_PER_MIN). Retry after the indicated seconds.",
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/Error" } },
    },
  },
};

const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Google Search API",
    version: "1.0.0",
    description:
      "HTTP wrapper around the google-search module (Playwright-based Google search). Requests beyond SEARCH_CONCURRENCY (default 2) queue. Auth: per-client keys configured via the API_KEYS env var ('project1:key1,project2:key2'); send yours as X-Api-Key header or ?key= param. Each key is limited to RATE_LIMIT_PER_MIN requests per minute (default 30).",
  },
  servers: [{ url: "/", description: "this server" }],
  tags: [
    { name: "search", description: "Google search operations" },
    { name: "meta", description: "Service info" },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: "apiKey", in: "header", name: "X-Api-Key" },
    },
    schemas: {
      SearchResult: {
        type: "object",
        properties: {
          title: { type: "string" },
          link: { type: "string", format: "uri" },
          snippet: { type: "string" },
        },
      },
      SearchResponse: {
        type: "object",
        properties: {
          query: { type: "string" },
          results: {
            type: "array",
            items: { $ref: "#/components/schemas/SearchResult" },
          },
        },
      },
      HtmlResponse: {
        type: "object",
        properties: {
          query: { type: "string" },
          html: {
            type: "string",
            description: "Cleaned page HTML (CSS and JavaScript removed)",
          },
          url: { type: "string", format: "uri" },
          savedPath: { type: "string" },
          screenshotPath: { type: "string" },
          originalHtmlLength: { type: "integer" },
        },
      },
      HealthStatus: {
        type: "object",
        properties: {
          status: { type: "string", example: "ok" },
          browserReady: { type: "boolean" },
          activeSearches: { type: "integer" },
          queuedSearches: { type: "integer" },
        },
      },
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
          query: { type: "string" },
        },
      },
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["meta"],
        summary: "Service status",
        security: [],
        responses: {
          200: {
            description: "OK",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthStatus" },
              },
            },
          },
        },
      },
    },
    "/docs": {
      get: {
        tags: ["meta"],
        summary: "This Swagger UI page (also served at /)",
        security: [],
        responses: { 200: { description: "HTML page" } },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["meta"],
        summary: "OpenAPI 3 specification",
        security: [],
        responses: { 200: { description: "OpenAPI document" } },
      },
    },
    "/search": {
      get: {
        tags: ["search"],
        summary: "Google search",
        security: [{ ApiKeyAuth: [] }, {}],
        parameters: [
          {
            name: "q",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "Search query",
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 20, default: 10 },
            description: "Max results",
          },
          {
            name: "timeout",
            in: "query",
            schema: { type: "integer", minimum: 1000, default: 60000 },
            description: "Search timeout in ms (capped by MAX_TIMEOUT env)",
          },
          {
            name: "locale",
            in: "query",
            schema: { type: "string", example: "en-US" },
            description: "Results locale (default zh-CN)",
          },
          {
            name: "key",
            in: "query",
            schema: { type: "string" },
            description: "API key (alternative to the X-Api-Key header)",
          },
        ],
        responses: searchResponses,
      },
      post: {
        tags: ["search"],
        summary: "Google search (JSON body)",
        security: [{ ApiKeyAuth: [] }, {}],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["query"],
                properties: {
                  query: { type: "string" },
                  limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
                  timeout: { type: "integer", minimum: 1000, default: 60000 },
                  locale: { type: "string" },
                },
              },
            },
          },
        },
        responses: searchResponses,
      },
    },
    "/html": {
      get: {
        tags: ["search"],
        summary: "Cleaned raw HTML of the results page",
        description:
          "Heavy: launches its own browser per call instead of the shared instance.",
        security: [{ ApiKeyAuth: [] }, {}],
        parameters: [
          {
            name: "q",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "Search query",
          },
          {
            name: "key",
            in: "query",
            schema: { type: "string" },
            description: "API key (alternative to the X-Api-Key header)",
          },
        ],
        responses: {
          200: {
            description: "OK",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HtmlResponse" },
              },
            },
          },
          400: {
            description: "Missing q",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Error" } },
            },
          },
          401: {
            description: "Invalid or missing API key",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Error" } },
            },
          },
          429: {
            description: "Rate limit exceeded for this API key",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Error" } },
            },
          },
          502: {
            description: "Fetch failed",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Error" } },
            },
          },
        },
      },
    },
  },
};

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function authenticate(req, url) {
  if (apiKeys.size === 0) return { label: "anonymous" };
  const presented = req.headers["x-api-key"] || url.searchParams.get("key") || "";
  if (!presented) return null;
  for (const [key, label] of apiKeys) {
    if (safeEqual(presented, key)) return { label };
  }
  return null;
}

const rateBuckets = new Map();

function checkRateLimit(label) {
  if (!RATE_LIMIT_PER_MIN) return { ok: true };
  const now = Date.now();
  let bucket = rateBuckets.get(label);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60000 };
    rateBuckets.set(label, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_PER_MIN) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { ok: true };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      status: "ok",
      browserReady: !!globalBrowser,
      activeSearches: activeCount,
      queuedSearches: waitQueue.length,
    });
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/docs")) {
    return sendHtml(res, 200, swaggerHtml);
  }

  if (req.method === "GET" && url.pathname === "/openapi.json") {
    return sendJson(res, 200, openapiSpec);
  }

  const auth = authenticate(req, url);
  if (!auth) {
    return sendJson(res, 401, { error: "Invalid API key" });
  }

  const rate = checkRateLimit(auth.label);
  if (!rate.ok) {
    res.setHeader("Retry-After", String(rate.retryAfter));
    return sendJson(res, 429, { error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfter });
  }

  try {
    if (url.pathname === "/search" && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await readJsonBody(req) : {};
      const query = String(body.query ?? url.searchParams.get("q") ?? "").trim();
      if (!query) {
        return sendJson(res, 400, {
          error: 'Missing query: GET /search?q=... or POST body {"query": "..."}',
        });
      }

      const options = {
        limit: clampInt(body.limit ?? url.searchParams.get("limit"), 1, 20, 10),
        timeout: clampInt(
          body.timeout ?? url.searchParams.get("timeout"),
          1000,
          MAX_TIMEOUT,
          60000
        ),
        stateFile: stateFilePath,
      };
      const localeParam = String(body.locale ?? url.searchParams.get("locale") ?? "").trim();
      if (localeParam) options.locale = localeParam;

      logger.info({ query, options, client: auth.label }, "API search request");
      const result = await withSlot(() => googleSearch(query, options, globalBrowser));

      if (isFailureResult(result)) {
        logger.warn({ query }, "API search failed");
        const snippet = result.results[0].snippet || "";
        const marker = "错误信息:";
        const underlying = snippet.includes(marker)
          ? snippet.slice(snippet.indexOf(marker) + marker.length).trim()
          : snippet;
        return sendJson(res, 502, { error: `Search failed: ${underlying}`, query });
      }

      if (Array.isArray(result.results) && RESOLVE_REDIRECTS) {
        await Promise.all(
          result.results.map(async (item) => {
            if (
              item &&
              typeof item.link === "string" &&
              isGoogleRedirectWrapper(item.link)
            ) {
              item.link = await resolveGoogleRedirect(item.link);
            }
          })
        );
      } else if (Array.isArray(result.results)) {
        for (const item of result.results) {
          if (item && typeof item.link === "string") {
            item.link = unwrapGoogleRedirect(item.link);
          }
        }
      }
      return sendJson(res, 200, result);
    }

    if (url.pathname === "/html" && req.method === "GET") {
      const query = (url.searchParams.get("q") || "").trim();
      if (!query) {
        return sendJson(res, 400, { error: "Missing query parameter q" });
      }
      logger.info({ query, client: auth.label }, "API get-HTML request");
      const result = await withSlot(() =>
        getGoogleSearchPageHtml(query, { stateFile: stateFilePath })
      );
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, {
      error: "Not found",
      available: [
        "GET / or /docs (Swagger UI)",
        "GET /openapi.json",
        "GET /health",
        "GET|POST /search?q=<query>&limit=&timeout=&locale=",
        "GET /html?q=<query>",
      ],
    });
  } catch (error) {
    logger.error({ error }, "API request handling failed");
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

async function cleanup() {
  if (globalBrowser) {
    logger.info("Closing global browser instance...");
    try {
      await globalBrowser.close();
    } catch (error) {
      logger.error({ error }, "Failed to close browser instance");
    }
    globalBrowser = undefined;
  }
}


function isGoogleFamilyHost(hostname) {
  return /^(\w+\.)*(google\.[a-z.]+|doubleclick\.net|googleadservices\.com)$/.test(
    hostname
  );
}

function isGoogleRedirectWrapper(link) {
  try {
    const url = new URL(link);
    return (
      isGoogleFamilyHost(url.hostname) &&
      (url.pathname === "/url" ||
        url.pathname === "/goto" ||
        url.pathname === "/aclk" ||
        url.pathname.endsWith("/aclk"))
    );
  } catch {
    return false;
  }
}

function unwrapGoogleRedirect(link) {
  if (!isGoogleRedirectWrapper(link)) return link;
  try {
    const url = new URL(link);
    const target =
      url.searchParams.get("q") ||
      url.searchParams.get("url") ||
      url.searchParams.get("adurl");
    if (target && /^https?:\/\//i.test(target)) return target;
  } catch { }
  return link;
}

async function resolveGoogleRedirect(link) {
  const embedded = unwrapGoogleRedirect(link);
  if (embedded !== link) return embedded;
  let current = link;
  for (let hop = 0; hop < 4; hop++) {
    let response;
    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      });
    } catch (error) {
      console.error("Gagal menyelesaikan redirect", error);
      return current;
    }
    try {
      await response.body?.cancel();
    } catch { }
    const location = response.headers.get("location");
    if (!(response.status >= 300 && response.status < 400) || !location) {
      return current;
    }
    try {
      current = new URL(location, current).href;
    } catch {
      return current;
    }
    if (!isGoogleFamilyHost(new URL(current).hostname)) return current;
  }
  return current;
}


async function main() {
  logger.info(
    {
      port: PORT,
      host: HOST,
      moduleDir: MODULE_DIR,
      maxConcurrency: MAX_CONCURRENCY,
      auth: apiKeys.size > 0,
      clients: Array.from(apiKeys.values()),
    },
    "Starting Google Search API server..."
  );

  globalBrowser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-site-isolation-trials",
      "--disable-web-security",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-component-extensions-with-background-pages",
      "--disable-extensions",
      "--disable-features=TranslateUI",
      "--disable-ipc-flooding-protection",
      "--disable-renderer-backgrounding",
      "--enable-features=NetworkService,NetworkServiceInProcess",
      "--force-color-profile=srgb",
      "--metrics-recording-only",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  logger.info("Global browser instance initialized");

  server.listen(PORT, HOST, () => {
    logger.info(`Google Search API server listening: http://0.0.0.0:3000`);
  });

  process.on("exit", async () => {
    await cleanup();
  });

  process.on("SIGINT", async () => {
    logger.info("Received SIGINT, shutting down API server...");
    server.close();
    await cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Received SIGTERM, shutting down API server...");
    server.close();
    await cleanup();
    process.exit(0);
  });
}

main().catch(async (error) => {
  logger.error({ error }, "API server startup failed");
  await cleanup();
  process.exit(1);
});
