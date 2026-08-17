const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

test("CLI renders help under the supported Node runtime", () => {
  const output = execFileSync(
    process.execPath,
    [path.join(__dirname, "..", "build", "index.js"), "--help"],
    { encoding: "utf8" },
  );

  assert.match(output, /Matrix XMPP Puppet Bridge/);
  assert.match(output, /--register/);
});
