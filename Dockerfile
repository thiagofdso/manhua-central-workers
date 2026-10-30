FROM node:20-slim

# Install latest chrome dev package and fonts to support major charsets
RUN apt-get update \
    && apt-get install -y wget gnupg dumb-init xvfb xauth libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2 libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PUPPETEER_CACHE_DIR=/opt/puppeteer

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev && mkdir -p /data/cover-profiles && chown -R node:node /data && chmod -R a+rX /opt/puppeteer

ARG COVER_CHROME_VERSION=150.0.7871.24
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && mkdir -p /opt/cover-chrome \
    && wget -qO /tmp/cover-chrome.zip "https://storage.googleapis.com/chrome-for-testing-public/${COVER_CHROME_VERSION}/linux64/chrome-linux64.zip" \
    && unzip -q /tmp/cover-chrome.zip -d /opt/cover-chrome \
    && chmod -R a+rX /opt/cover-chrome \
    && rm -f /tmp/cover-chrome.zip \
    && rm -rf /var/lib/apt/lists/*
ENV COVER_BROWSER_EXECUTABLE=/opt/cover-chrome/chrome-linux64/chrome
ENV COVER_BROWSER_HEADLESS=true

# Run with dumb-init as non-root user
USER node

EXPOSE 50051

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["sh", "-c", "if [ \"$COVER_BROWSER_HEADLESS\" = \"false\" ]; then exec xvfb-run -a node dist/index.js; else exec node dist/index.js; fi"]
