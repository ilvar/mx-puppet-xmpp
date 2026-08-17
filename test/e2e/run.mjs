import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire("/opt/mx-puppet-xmpp/package.json");
const { client, xml } = require("@xmpp/client");

const MATRIX_URL = process.env.MATRIX_URL || "http://synapse:8008";
const MATRIX_DOMAIN = process.env.MATRIX_DOMAIN || "matrix.test";
const MATRIX_SECRET = process.env.MATRIX_REGISTRATION_SECRET || "e2e-registration-secret";
const XMPP_URL = process.env.XMPP_URL || "ws://prosody:5280/xmpp-websocket";
const XMPP_DOMAIN = process.env.XMPP_DOMAIN || "xmpp.test";

const MATRIX_USER = "alice";
const MATRIX_PASSWORD = "matrixpass";
const MATRIX_MXID = `@${MATRIX_USER}:${MATRIX_DOMAIN}`;
const BOT_MXID = `@_xmpppuppet_bot:${MATRIX_DOMAIN}`;
const PUPPET_JID = `alice@${XMPP_DOMAIN}`;
const PUPPET_PASSWORD = "alicepass";
const REMOTE_JID = `bob@${XMPP_DOMAIN}`;
const REMOTE_PASSWORD = "bobpass";
const TIMEOUT_MS = 45_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, { method = "GET", token, body, expected = [200] } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${MATRIX_URL}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = text;
        }
    }
    if (!expected.includes(response.status)) {
        throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
    }
    return parsed;
}

async function retry(name, fn, timeoutMs = TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            await sleep(500);
        }
    }
    throw new Error(`${name} timed out: ${lastError?.message || lastError || "condition not met"}`);
}

async function registerMatrixUser() {
    const { nonce } = await request("/_synapse/admin/v1/register");
    const mac = createHmac("sha1", MATRIX_SECRET);
    mac.update(nonce);
    mac.update("\0");
    mac.update(MATRIX_USER);
    mac.update("\0");
    mac.update(MATRIX_PASSWORD);
    mac.update("\0");
    mac.update("notadmin");
    await request("/_synapse/admin/v1/register", {
        method: "POST",
        body: {
            nonce,
            username: MATRIX_USER,
            password: MATRIX_PASSWORD,
            admin: false,
            mac: mac.digest("hex"),
        },
    });
}

async function loginMatrix() {
    const response = await request("/_matrix/client/v3/login", {
        method: "POST",
        body: {
            type: "m.login.password",
            identifier: { type: "m.id.user", user: MATRIX_MXID },
            password: MATRIX_PASSWORD,
            initial_device_display_name: "mx-puppet-xmpp e2e",
        },
    });
    assert.equal(response.user_id, MATRIX_MXID);
    return response.access_token;
}

async function waitForBot(token) {
    await retry("bridge bot registration", async () => {
        await request(`/_matrix/client/v3/profile/${encodeURIComponent(BOT_MXID)}`, {
            token,
            expected: [200],
        });
    });
}

async function createStatusRoom(token) {
    const response = await request("/_matrix/client/v3/createRoom", {
        method: "POST",
        token,
        body: {
            preset: "trusted_private_chat",
            is_direct: true,
            invite: [BOT_MXID],
            name: "XMPP bridge E2E status",
        },
    });
    const roomId = response.room_id;
    await retry("bridge bot joining status room", async () => {
        const member = await request(
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(BOT_MXID)}`,
            { token },
        );
        assert.equal(member.membership, "join");
    });
    return roomId;
}

async function sendMatrixText(token, roomId, body) {
    const txn = randomUUID();
    await request(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txn)}`,
        {
            method: "PUT",
            token,
            body: { msgtype: "m.text", body },
        },
    );
}

async function recentRoomMessages(token, roomId) {
    const response = await request(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`,
        { token },
    );
    return response.chunk || [];
}

async function waitForRoomMessage(token, roomId, predicate, name) {
    return retry(name, async () => {
        const events = await recentRoomMessages(token, roomId);
        const event = events.find((candidate) => (
            candidate.type === "m.room.message" &&
            candidate.sender !== MATRIX_MXID &&
            predicate(candidate.content?.body || "")
        ));
        assert.ok(event, "message not present yet");
        return event;
    });
}

async function waitForRemoteRoom(token, statusRoomId) {
    let since;
    const knownJoined = new Set([statusRoomId]);
    return retry("remote Matrix DM creation", async () => {
        const suffix = new URLSearchParams({ timeout: "1000" });
        if (since) suffix.set("since", since);
        const sync = await request(`/_matrix/client/v3/sync?${suffix}`, { token });
        since = sync.next_batch;

        for (const roomId of Object.keys(sync.rooms?.join || {})) {
            knownJoined.add(roomId);
        }
        for (const roomId of Object.keys(sync.rooms?.invite || {})) {
            await request(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
                method: "POST",
                token,
                body: {},
            });
            knownJoined.add(roomId);
        }

        const candidates = [...knownJoined].filter((roomId) => roomId !== statusRoomId);
        assert.ok(candidates.length > 0, "remote room not visible yet");
        return candidates[0];
    });
}

function bareJid(jid) {
    return jid.split("/", 1)[0];
}

async function connectXmpp(username, password, resource) {
    return retry(`XMPP login for ${username}`, async () => {
        const api = client({
            service: XMPP_URL,
            domain: XMPP_DOMAIN,
            username,
            password,
            resource,
        });
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("XMPP online timeout")), 8_000);
                api.once("online", () => {
                    clearTimeout(timer);
                    resolve();
                });
                api.once("error", (err) => {
                    clearTimeout(timer);
                    reject(err);
                });
                Promise.resolve(api.start()).catch(reject);
            });
            await api.send(xml("presence"));
            return api;
        } catch (err) {
            try { await api.stop(); } catch {}
            throw err;
        }
    });
}

function waitForXmppBody(api, expectedBody, expectedFrom) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            api.removeListener("stanza", onStanza);
            reject(new Error(`Did not receive XMPP body: ${expectedBody}`));
        }, TIMEOUT_MS);
        const onStanza = (stanza) => {
            if (!stanza.is("message")) return;
            const body = stanza.getChild("body");
            if (!body || body.text() !== expectedBody) return;
            if (expectedFrom && bareJid(stanza.attrs.from || "") !== expectedFrom) return;
            clearTimeout(timer);
            api.removeListener("stanza", onStanza);
            resolve(stanza);
        };
        api.on("stanza", onStanza);
    });
}

async function runCase(name, fn) {
    const started = Date.now();
    process.stdout.write(`E2E ${name} ... `);
    await fn();
    console.log(`ok (${Date.now() - started} ms)`);
}

let bob;
try {
    await retry("Synapse readiness", async () => {
        await request("/_matrix/client/versions");
    });
    await registerMatrixUser();
    const token = await loginMatrix();
    await waitForBot(token);
    const statusRoom = await createStatusRoom(token);

    await runCase("rejects invalid XMPP credentials", async () => {
        await sendMatrixText(token, statusRoom, `link ${PUPPET_JID} definitely-wrong`);
        await waitForRoomMessage(
            token,
            statusRoom,
            (body) => body.includes("ERROR: Could not authenticate to XMPP"),
            "invalid-login response",
        );
    });

    await runCase("links a valid XMPP account", async () => {
        await sendMatrixText(token, statusRoom, `link ${PUPPET_JID} ${PUPPET_PASSWORD}`);
        await waitForRoomMessage(
            token,
            statusRoom,
            (body) => body.includes("Created new link with ID"),
            "successful-link response",
        );
    });

    bob = await connectXmpp("bob", REMOTE_PASSWORD, `e2e-${randomUUID()}`);

    await runCase("ignores body-less XMPP stanzas", async () => {
        await bob.send(xml(
            "message",
            { type: "chat", to: PUPPET_JID },
            xml("active", { xmlns: "http://jabber.org/protocol/chatstates" }),
        ));
        await sleep(500);
        const bootstrap = `bootstrap-${randomUUID()}`;
        await bob.send(xml(
            "message",
            { type: "chat", to: PUPPET_JID, id: randomUUID() },
            xml("body", {}, bootstrap),
        ));
    });

    const remoteRoom = await waitForRemoteRoom(token, statusRoom);

    await runCase("bridges XMPP to Matrix", async () => {
        const body = `xmpp-to-matrix-${randomUUID()}`;
        await bob.send(xml(
            "message",
            { type: "chat", to: PUPPET_JID, id: randomUUID() },
            xml("body", {}, body),
        ));
        await waitForRoomMessage(
            token,
            remoteRoom,
            (candidate) => candidate === body,
            "XMPP to Matrix delivery",
        );
    });

    await runCase("bridges Matrix to XMPP", async () => {
        const body = `matrix-to-xmpp-${randomUUID()}`;
        const received = waitForXmppBody(bob, body, PUPPET_JID);
        await sendMatrixText(token, remoteRoom, body);
        await received;
    });

    console.log("E2E suite passed: 5/5 cases");
} finally {
    if (bob) {
        try { await bob.stop(); } catch {}
    }
}
