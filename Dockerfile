FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src ./src
COPY bin ./bin
COPY google-search-api ./google-search-api
RUN npm run build

ENV NODE_ENV=production
ENV GOOGLE_SEARCH_DIR=/app

CMD ["node", "google-search-api/server.mjs"]
