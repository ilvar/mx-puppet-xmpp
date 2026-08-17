#!/bin/sh
set -eu

COMPOSE_FILE="test/e2e/compose.yaml"

compose() {
    docker compose -f "$COMPOSE_FILE" "$@"
}

cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ "$status" -ne 0 ]; then
        echo "\nE2E failed; compose state:" >&2
        compose ps >&2 || true
        echo "\nE2E service logs:" >&2
        compose logs --no-color >&2 || true
    fi
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    exit "$status"
}
trap cleanup EXIT INT TERM

compose config >/dev/null
compose up -d --build bridge synapse prosody
compose run --rm --no-deps e2e
