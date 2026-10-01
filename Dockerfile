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
