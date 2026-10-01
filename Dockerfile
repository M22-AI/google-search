FROM mcr.microsoft.com/playwright:v1.50.1-jammy

ARG GOOGLE_SEARCH_REF=367aa01

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm

WORKDIR /app
RUN git clone https://github.com/web-agent-master/google-search.git \
    && cd google-search \
    && git checkout ${GOOGLE_SEARCH_REF}

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN cd google-search \
    && pnpm install \
    && pnpm build

COPY server.mjs package.json /app/google-search-api/

WORKDIR /app/google-search-api
ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
