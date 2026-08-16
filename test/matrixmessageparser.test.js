const test = require("node:test");
const assert = require("node:assert/strict");
const { MatrixMessageParser } = require("../build/matrixmessageparser.js");

const parser = new MatrixMessageParser();

test("formatted Matrix text becomes XEP-0393-style plain text", () => {
  assert.equal(
    parser.parse("<strong>bold</strong> <em>italic</em><br><del>gone</del>"),
    "*bold* _italic_\n~gone~",
  );
});

test("HTML entities are decoded and not pre-escaped for XMPP XML", () => {
  assert.equal(parser.parse("a &lt; b &amp; c"), "a < b & c");
});

test("Matrix reply fallback is removed", () => {
  assert.equal(
    parser.parse("<mx-reply><blockquote>old text</blockquote></mx-reply><p>new text</p>"),
    "new text",
  );
});

test("links retain their target when label differs", () => {
  assert.equal(
    parser.parse('<a href="https://example.org">example</a>'),
    "example (https://example.org)",
  );
});
