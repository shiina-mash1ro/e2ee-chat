import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExtensionInfo,
  normalizeChatOrigin,
  permissionPattern,
  validateChatOrigin,
} from "../extension/src/origin.js";
import { MAX_CUSTOM_CSS_BYTES, validateCustomCss } from "../extension/src/custom-css.js";

test("normalizes only supported service origins", () => {
  assert.equal(normalizeChatOrigin("https://chat.example.com"), "https://chat.example.com");
  assert.equal(normalizeChatOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(permissionPattern("http://127.0.0.1:8080"), "http://127.0.0.1/*");
  assert.throws(() => normalizeChatOrigin("https://chat.example.com/path"), /不含路径/);
  assert.throws(() => normalizeChatOrigin("http://chat.example.com"), /HTTPS/);
});

test("requires an exact compatible service identity", () => {
  const valid = { app: "e2ee-chat", extensionApi: 1, protocol: 4, build: "test" };
  assert.equal(assertExtensionInfo(valid), valid);
  for (const invalid of [
    { ...valid, app: "other" },
    { ...valid, extensionApi: 2 },
    { ...valid, protocol: 2 },
    { ...valid, build: "" },
  ]) assert.throws(() => assertExtensionInfo(invalid), /兼容/);
});

test("validates the identity endpoint without caching", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ app: "e2ee-chat", extensionApi: 1, protocol: 4, build: "test-build" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await validateChatOrigin("https://chat.example.com", 100);
    assert.equal(result.origin, "https://chat.example.com");
    assert.equal(result.info.build, "test-build");
    assert.equal(request.url, "https://chat.example.com/api/extension-info");
    assert.equal(request.options.cache, "no-store");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts only bounded CSS files", () => {
  assert.equal(validateCustomCss(".widget { color: red; }", 23, "theme.css"), ".widget { color: red; }");
  assert.throws(() => validateCustomCss("x", 1, "theme.txt"), /\.css/);
  assert.throws(() => validateCustomCss("", 0, "theme.css"), /不能为空/);
  assert.throws(() => validateCustomCss("x", MAX_CUSTOM_CSS_BYTES + 1, "theme.css"), /100 KiB/);
});
