# mx-puppet-xmpp

A Matrix puppeting bridge for XMPP based on `mx-puppet-bridge`.

## Current support

- Multi-user account linking
- One-to-one text messages in both directions
- Matrix formatted text converted to XEP-0393-style plain-text markup
- XEP-0156 WebSocket endpoint discovery via `host-meta` / `host-meta.json`
- Automatic reconnect with bounded exponential backoff

Not yet supported: replies, edits, retractions, media, typing notifications, presence bridging, MUCs, MAM/history sync, or OMEMO.

## Requirements

- Node.js 24
- A Matrix homeserver with application-service support
- An XMPP server exposing a secure WebSocket endpoint through XEP-0156, or an explicit endpoint via `XMPP_WEBSOCKET_URL`

Plain `ws://` XMPP endpoints are rejected by default. For trusted development environments only, set `XMPP_ALLOW_INSECURE_WEBSOCKET=true`.

## Install from source

```sh
git clone https://github.com/ilvar/mx-puppet-xmpp.git
cd mx-puppet-xmpp
npm ci
cp sample.config.yaml config.yaml
# edit config.yaml
npm run start -- -r
npm run start
```

Copy the generated `xmpp-registration.yaml` into your Synapse configuration and add it to `app_service_config_files` before starting the bridge.

Start a direct chat with the bridge bot (normally `@_xmpppuppet_bot:domain.tld`) and link an account with:

```text
link user@example.org password
```

The bridge database contains the XMPP credentials needed to reconnect accounts. Protect the database and its backups accordingly.

## Docker

The published image uses Node 24 on Debian and runs the bridge process as the unprivileged `node` user after preparing `/data`.

```sh
docker build -t mx-puppet-xmpp:latest .
docker run --rm -v "$PWD/data:/data" mx-puppet-xmpp:latest
```

Expected files under `/data`:

- `config.yaml`
- `xmpp-registration.yaml` (generated automatically when missing)
- the configured SQLite database and logs

Useful environment variables:

- `CONFIG_PATH` — defaults to `/data/config.yaml`
- `REGISTRATION_PATH` — defaults to `/data/xmpp-registration.yaml`
- `XMPP_WEBSOCKET_URL` — bypass XEP-0156 discovery with a fixed endpoint
- `XMPP_ALLOW_INSECURE_WEBSOCKET=true` — permit `ws://` instead of requiring `wss://`

## Development

```sh
npm ci
npm run check
```

`npm run check` runs ESLint, TypeScript compilation, the Node unit tests, native dependency smoke tests, and the critical-level dependency audit.

### End-to-end tests

The E2E suite is self-contained and requires only Docker with Compose v2:

```sh
npm run test:e2e
```

It builds the current bridge image and starts isolated Synapse and Prosody containers, generates the Matrix application-service registration, creates Matrix/XMPP test accounts, links the XMPP account through the real bridge bot flow, and then tears the stack down including its volumes.

The black-box suite verifies:

1. invalid XMPP credentials are rejected rather than creating a link;
2. valid XMPP credentials create a puppet;
3. body-less XMPP message stanzas do not break the bridge;
4. XMPP → Matrix text delivery;
5. Matrix → XMPP text delivery.

On failure, the runner prints the full Compose service state and logs before cleanup. The same suite runs automatically in the `E2E` GitHub Actions workflow.
