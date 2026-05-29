const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

// P3-3: esc() must escape the five HTML-significant chars, including BOTH
// quote styles, because it is interpolated into attribute values
// (e.g. value="${esc(...)}", data-id="${esc(...)}"). Pure function — no jsdom.
// esc() now lives in the ES module public/js/util.mjs; dynamic import() lets
// this CommonJS test consume it without renaming the file to .mjs (so the
// tests/**/*.test.js glob still discovers it).
describe("esc() (P3-3)", () => {
  let esc;
  before(async () => { ({ esc } = await import("../public/js/util.mjs")); });

  it("escapes < and >", () => {
    assert.equal(esc("<script>"), "&lt;script&gt;");
  });

  it("escapes & first (no double-encoding ordering bug)", () => {
    assert.equal(esc("a & b"), "a &amp; b");
    assert.equal(esc("<&>"), "&lt;&amp;&gt;");
  });

  it("escapes double quotes (attribute breakout)", () => {
    assert.equal(esc('x" onmouseover="alert(1)'), "x&quot; onmouseover=&quot;alert(1)");
  });

  it("escapes single quotes", () => {
    assert.equal(esc("it's"), "it&#39;s");
  });

  it("escapes all five in one string", () => {
    assert.equal(esc(`<a href="x" data='y'>&`), "&lt;a href=&quot;x&quot; data=&#39;y&#39;&gt;&amp;");
  });

  it("treats null/undefined as empty string", () => {
    assert.equal(esc(null), "");
    assert.equal(esc(undefined), "");
  });

  it("coerces non-strings", () => {
    assert.equal(esc(42), "42");
  });

  it("leaves safe text untouched", () => {
    assert.equal(esc("plain text 123"), "plain text 123");
  });
});
