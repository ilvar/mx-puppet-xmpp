FROM node:24-trixie-slim AS builder

WORKDIR /opt/mx-puppet-xmpp

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        make \
        g++ \
        libcairo2-dev \
        libjpeg62-turbo-dev \
        libpango1.0-dev \
        libgif-dev \
        librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json eslint.config.mjs ./
COPY src/ ./src/
COPY test/ ./test/
RUN npm run check \
    && npm prune --omit=dev

FROM node:24-trixie-slim

ENV CONFIG_PATH=/data/config.yaml \
    REGISTRATION_PATH=/data/xmpp-registration.yaml \
    NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        gosu \
        tini \
        libcairo2 \
        libjpeg62-turbo \
        libpango-1.0-0 \
        libgif7 \
        librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/mx-puppet-xmpp
COPY docker-run.sh ./
COPY --from=builder /opt/mx-puppet-xmpp/node_modules/ ./node_modules/
COPY --from=builder /opt/mx-puppet-xmpp/build/ ./build/

VOLUME /data
WORKDIR /data
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/mx-puppet-xmpp/docker-run.sh"]
