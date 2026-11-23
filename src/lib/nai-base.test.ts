import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { naiMigrationBase, normalizeNaiBase } from "./nai-base.ts";

describe("normalizeNaiBase", () => {
  it("keeps the host and drops a trailing /api", () => {
    assert.equal(normalizeNaiBase("https://api.yihan.art"), "https://api.yihan.art");
    assert.equal(normalizeNaiBase("https://api.yihan.art/"), "https://api.yihan.art");
    assert.equal(normalizeNaiBase("https://api.yihan.art/api"), "https://api.yihan.art");
    assert.equal(normalizeNaiBase("https://api.yihan.art/api/"), "https://api.yihan.art");
    assert.equal(normalizeNaiBase("https://api.yihan.art/api/api"), "https://api.yihan.art");
  });

  it("drops a pasted endpoint and still keeps a gateway prefix", () => {
    assert.equal(normalizeNaiBase("https://api.yihan.art/api/generate_image"), "https://api.yihan.art");
    assert.equal(normalizeNaiBase("https://api.yihan.art/api/ai/generate-image"), "https://api.yihan.art");
    assert.equal(normalizeNaiBase("https://example.com/gateway/api"), "https://example.com/gateway");
    assert.equal(normalizeNaiBase("api.yihan.art/api"), "https://api.yihan.art");
  });

  it("uses the current default when empty", () => {
    assert.equal(normalizeNaiBase(""), "https://api.yihan.art");
    assert.equal(normalizeNaiBase("   "), "https://api.yihan.art");
  });
});

describe("naiMigrationBase", () => {
  it("reads the new address from the old host and strips /api", () => {
    const body = JSON.stringify({
      code: "API_DOMAIN_CHANGED",
      message: "API 域名已迁移，请使用最新地址 https://api.yihan.art/api",
      api_base_url: "https://api.yihan.art/api",
    });
    assert.equal(naiMigrationBase(410, body), "https://api.yihan.art");
  });

  it("does not follow a link in a web page", () => {
    assert.equal(naiMigrationBase(404, "<html>https://evil.example/api</html>"), null);
    assert.equal(naiMigrationBase(401, JSON.stringify({ message: "Invalid API key." })), null);
  });
});
