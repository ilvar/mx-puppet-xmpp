const test = require("node:test");
const assert = require("node:assert/strict");
const { bareJid, parseJid } = require("../build/jid.js");

test("bareJid removes the resource", () => {
  assert.equal(bareJid("alice@example.org/phone"), "alice@example.org");
  assert.equal(bareJid("alice@example.org"), "alice@example.org");
});

test("parseJid validates and splits a JID", () => {
  assert.deepEqual(parseJid("alice@example.org/laptop"), {
    bare: "alice@example.org",
    local: "alice",
    domain: "example.org",
  });
  assert.throws(() => parseJid("not-a-jid"), /Invalid XMPP JID/);
});
