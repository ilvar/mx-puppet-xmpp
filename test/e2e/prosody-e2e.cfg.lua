-- E2E-only settings. The test network is private to Docker Compose.
-- Prosody intentionally binds unencrypted HTTP to loopback by default; expose
-- it to the private Compose network so XMPP-over-WebSocket is reachable.
http_interfaces = { "0.0.0.0", "::" }
c2s_require_encryption = false
consider_websocket_secure = true
