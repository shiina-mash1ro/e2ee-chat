import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { catalogs, supportedLocales, normalizeLocale, detectLocale, getLocale, getLocalePreference, setLocale, onLocaleChange, t } from "../src/i18n.js";

test("all twelve catalogs have complete keys and preserve named placeholders", () => {
  assert.equal(supportedLocales.length, 12);
  const keys = Object.keys(catalogs.en).sort();
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(catalogs[locale]).sort(), keys, `${locale}: missing or extra keys`);
    for (const key of keys) {
      const text = catalogs[locale][key];
      assert.equal(typeof text, "string", `${locale}:${key}`);
      assert.ok(text.trim(), `${locale}:${key}: empty value`);
      assert.deepEqual(placeholders(text), placeholders(catalogs.en[key]), `${locale}:${key}: placeholder mismatch`);
      assert.ok(!/Message supplémentaire|Zusätzliche Nachricht|Mensaje adicional|Mensagem adicional|Дополнительное сообщение|رسالة إضافية|अतिरिक्त संदेश|추가 메시지/.test(text), `${locale}:${key}: filler translation`);
    }
    if (locale !== "en") {
      const copied = keys.filter((key) => catalogs[locale][key] === catalogs.en[key]);
      assert.ok(copied.length < keys.length / 5, `${locale} contains too many untranslated English values: ${copied.length}`);
    }
  }
});

test("regional locale matching, browser preference order and fallback", () => {
  for (const [input, expected] of [["zh-Hant-HK", "zh-TW"], ["zh-SG", "zh-CN"], ["pt-BR", "pt"], ["EN_us", "en"], ["ja-JP", "ja"]]) assert.equal(normalizeLocale(input), expected);
  assert.equal(normalizeLocale("xx"), null);
  assert.equal(detectLocale(["xx", "fr-CA"]), "fr");
  assert.equal(detectLocale(["xx"]), "en");
});

test("strong room naming is consistent between the web and extension", () => {
  assert.equal(catalogs.en["web.createBigRoom"], "Create strong room");
  for (const locale of supportedLocales) {
    assert.equal(catalogs[locale]["web.createBigRoom"], catalogs[locale]["ext.popup.createStrong"], locale);
  }
});

test("runtime switching, interpolation, safe fallback and UI source aliases", async () => {
  const calls = [];
  const unsubscribe = onLocaleChange((value) => calls.push(value));
  await setLocale("en");
  assert.equal(t("web.title"), catalogs.en["web.title"]);
  assert.equal(t(catalogs["zh-CN"]["web.title"]), catalogs.en["web.title"]);
  assert.ok(t("web.guest", { digits: "1234" }).includes("1234"));
  assert.equal(t("unknown text"), "unknown text");
  for (const text of ["constructor", "toString", "__proto__"]) assert.equal(t(text), text);
  await setLocale("ar");
  assert.equal(getLocale(), "ar");
  assert.ok(calls.includes("ar"));
  unsubscribe();
  await setLocale("not-a-locale");
  assert.equal(getLocalePreference(), "auto");
});

test("every literal translation key in client source exists", () => {
  for (const file of ["../src/App.vue", "../extension/src/options.js", "../extension/src/popup.js", "../extension/src/widget.js", "../extension/src/offscreen.js", "../extension/src/service-worker.js", "../extension/src/channel.js", "../extension/src/origin.js", "../extension/src/custom-css.js"]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    for (const [, key] of source.matchAll(/\bt\(["']((?:web|ext|core)\.[^"']+)["']/g)) assert.ok(key in catalogs.en, `${file}: missing ${key}`);
  }
});
