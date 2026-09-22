import web from "./locales/web.js";
import extension from "./locales/extension.js";
import { CORE_LOCALES as core } from "./locales/core.js";
import errorsA from "./locales/errors-a.js";
import errorsB from "./locales/errors-b.js";
import common from "./locales/common.js";

export const LOCALE_STORAGE_KEY = "e2ee-chat-locale";
export const supportedLocales = ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "pt", "ru", "ar", "hi"];
export const localeOptions = [
  { value: "auto", get label() { return `🌐 ${t("i18n.auto")}`; } },
  { value: "zh-CN", label: "简体中文" }, { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" }, { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" }, { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" }, { value: "es", label: "Español" },
  { value: "pt", label: "Português" }, { value: "ru", label: "Русский" },
  { value: "ar", label: "العربية" }, { value: "hi", label: "हिन्दी" },
];
export const catalogs = Object.fromEntries(supportedLocales.map((locale) => [locale, {
  ...web[locale], ...extension[locale], ...core[locale], ...errorsA[locale], ...errorsB[locale], ...common[locale],
}]));

export function normalizeLocale(value) {
  const tag = String(value || "").toLowerCase().replaceAll("_", "-");
  if (tag === "zh" || tag.startsWith("zh-")) {
    return /(?:^|-)(?:hant|tw|hk|mo)(?:-|$)/.test(tag) ? "zh-TW" : "zh-CN";
  }
  const base = tag.split("-")[0];
  return supportedLocales.includes(base) ? base : null;
}

export function detectLocale(languages = globalThis.navigator?.languages || [globalThis.navigator?.language]) {
  for (const language of languages) {
    const locale = normalizeLocale(language);
    if (locale) return locale;
  }
  return "en";
}

function validPreference(value) { return supportedLocales.includes(value) ? value : "auto"; }
function readPreference() {
  try { return validPreference(globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY)); }
  catch { return "auto"; }
}
let preference = readPreference();
let locale = preference === "auto" ? detectLocale() : preference;
const listeners = new Set();
let initialized;
let localeChannel;
export const getLocale = () => locale;
export const getLocalePreference = () => preference;

function applyPreference(value) {
  const previousLocale = locale, previousPreference = preference;
  preference = validPreference(value);
  locale = preference === "auto" ? detectLocale() : preference;
  if (globalThis.document?.documentElement) {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
  }
  if (previousLocale !== locale || previousPreference !== preference) {
    for (const listener of listeners) listener(locale);
  }
}

export async function setLocale(value) {
  applyPreference(value);
  localeChannel?.postMessage(preference);
  try {
    if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ [LOCALE_STORAGE_KEY]: preference });
    else globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, preference);
  } catch { /* Language switching still works if preference storage is blocked. */ }
}

export function onLocaleChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function initLocale() {
  if (initialized) return initialized;
  initialized = (async () => {
    if (globalThis.chrome?.storage?.local) {
      try {
        const stored = await chrome.storage.local.get(LOCALE_STORAGE_KEY);
        applyPreference(stored[LOCALE_STORAGE_KEY]);
      } catch { applyPreference("auto"); }
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && LOCALE_STORAGE_KEY in changes) {
          applyPreference(changes[LOCALE_STORAGE_KEY].newValue);
          localeChannel?.postMessage(preference);
        }
      });
    } else if (globalThis.chrome?.runtime?.id) {
      // Offscreen documents only expose the runtime API, not chrome.storage.
      try {
        const response = await chrome.runtime.sendMessage({ type: "storage-get", area: "local", keys: LOCALE_STORAGE_KEY });
        applyPreference(response?.value?.[LOCALE_STORAGE_KEY]);
      } catch { applyPreference("auto"); }
    } else {
      applyPreference(readPreference());
      globalThis.addEventListener?.("storage", (event) => {
        if (event.key === LOCALE_STORAGE_KEY || event.key === null) applyPreference(event.newValue);
      });
    }
    if (globalThis.chrome?.runtime?.id && globalThis.BroadcastChannel) {
      localeChannel = new BroadcastChannel("e2ee-chat-language");
      localeChannel.onmessage = (event) => applyPreference(event.data);
    }
    globalThis.addEventListener?.("languagechange", () => {
      if (preference === "auto") applyPreference("auto");
    });
    applyPreference(preference);
  })();
  return initialized;
}

// Also translate persisted display statuses and error messages at render time.
// Only UI-owned text is passed here; chat messages and user names are never keys.
const aliases = new Map();
const patterns = [];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const dictionary of Object.values(catalogs)) {
  for (const [key, text] of Object.entries(dictionary)) {
    if (typeof text !== "string") continue;
    if (!aliases.has(text)) aliases.set(text, key);
    const matches = [...text.matchAll(/\{(\w+)\}/g)];
    if (!matches.length) continue;
    let offset = 0, pattern = "^";
    for (const match of matches) {
      pattern += escapeRegex(text.slice(offset, match.index)) + "([\\s\\S]*?)";
      offset = match.index + match[0].length;
    }
    pattern += escapeRegex(text.slice(offset)) + "$";
    if (text.replace(/\{\w+\}/g, "").length < 3) continue;
    patterns.push({ key, regex: new RegExp(pattern), names: matches.map((match) => match[1]) });
  }
}

for (const [source, key] of Object.entries({
  "WebSocket is not connected": "core.error.socketDisconnected",
  "Unknown key epoch": "core.error.unknownEpoch",
  "Unknown recipient key": "core.error.unknownRecipient",
})) aliases.set(source, key);
patterns.push(
  { key: "web.fileTooLarge", regex: /^File cannot exceed (.+?)(?: in the current connection mode)?\.$/, names: ["size"] },
  { key: "core.error.send", regex: /^Send failed: HTTP (\d+)$/, names: ["status"] },
);

export function t(input, params = {}) {
  const source = String(input ?? "");
  let key = source;
  if (!Object.hasOwn(catalogs.en, key) && !Object.hasOwn(catalogs["zh-CN"], key)) {
    key = aliases.get(source);
    if (!key && source.length <= 4096) {
      for (const pattern of patterns) {
        const match = pattern.regex.exec(source);
        if (!match) continue;
        key = pattern.key;
        params = { ...Object.fromEntries(pattern.names.map((name, index) => [name, match[index + 1]])), ...params };
        break;
      }
    }
  }
  const text = key && Object.hasOwn(catalogs.en, key)
    ? catalogs[locale]?.[key] ?? catalogs.en[key] ?? catalogs["zh-CN"][key]
    : source;
  return text.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}

export function translateError(error) { return t(error?.message || String(error)); }
