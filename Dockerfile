FROM node:alpine AS builder

WORKDIR /opt/mx-puppet-xmpp

# run build process as user in case of npm pre hooks
# pre hooks are not executed while running as root
RUN chown node:node /opt/mx-puppet-xmpp
RUN apk update && apk --no-cache add git python3 make g++ pkgconfig \
    build-base \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    musl-dev \
    giflib-dev \
    pixman-dev \
    pangomm-dev \
    libjpeg-turbo-dev \
    freetype-dev \
    && rm -rf /var/cache/apk/*

RUN wget -O /etc/apk/keys/sgerrand.rsa.pub https://alpine-pkgs.sgerrand.com/sgerrand.rsa.pub && \
    wget -O glibc-2.32-r0.apk https://github.com/sgerrand/alpine-pkg-glibc/releases/download/2.32-r0/glibc-2.32-r0.apk && \
    apk add glibc-2.32-r0.apk

COPY package.json package-lock.json ./
RUN chown node:node package.json package-lock.json

USER node

RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build


FROM node:alpine

VOLUME /data

ENV CONFIG_PATH=/data/config.yaml \
    REGISTRATION_PATH=/data/xmpp-registration.yaml

# su-exec is used by docker-run.sh to drop privileges
RUN apk update && apk add --no-cache su-exec \
    cairo \
    jpeg \
    pango \
    musl \
    giflib \
    pixman \
    pangomm \
    libjpeg-turbo \
    freetype \
    && rm -rf /var/cache/apk/*


WORKDIR /opt/mx-puppet-xmpp
COPY docker-run.sh ./
COPY --from=builder /opt/mx-puppet-xmpp/node_modules/ ./node_modules/
COPY --from=builder /opt/mx-puppet-xmpp/build/ ./build/

# change workdir to /data so relative paths in the config.yaml
# point to the persisten volume
WORKDIR /data
ENTRYPOINT ["/opt/mx-puppet-xmpp/docker-run.sh"]
