#!/bin/sh
set -eu

CONFIG_PATH="${CONFIG_PATH:-/data/config.yaml}"
REGISTRATION_PATH="${REGISTRATION_PATH:-/data/xmpp-registration.yaml}"

if [ ! -f "$CONFIG_PATH" ]; then
    echo "No config found at $CONFIG_PATH" >&2
    exit 1
fi

if [ ! -f "$REGISTRATION_PATH" ]; then
    echo "No registration found; generating $REGISTRATION_PATH"
    set -- -r
fi

if [ "$(id -u)" = 0 ]; then
    chown node:node /data
    find /data -maxdepth 1 -type f \( -name '*.db*' -o -name '*.log*' \) -exec chown node:node {} + 2>/dev/null || true
    exec gosu node:node /usr/local/bin/node /opt/mx-puppet-xmpp/build/index.js \
        -c "$CONFIG_PATH" \
        -f "$REGISTRATION_PATH" \
        "$@"
fi

exec /usr/local/bin/node /opt/mx-puppet-xmpp/build/index.js \
    -c "$CONFIG_PATH" \
    -f "$REGISTRATION_PATH" \
    "$@"
