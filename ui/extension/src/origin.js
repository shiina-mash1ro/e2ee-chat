export const EXTENSION_INFO_PATH = "/api/extension-info";
export const EXTENSION_API_VERSION = 1;
export const CHAT_PROTOCOL_VERSION = 4;
import { t } from "../../src/i18n.js";

export function normalizeChatOrigin(value) {
  const url = new URL(String(value || "").trim());
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(t("core.error.originShape"));
  }
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(t("core.error.originHttps"));
  }
  return url.origin;
}

export function permissionPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export function assertExtensionInfo(value) {
  if (!value || value.app !== "e2ee-chat" || value.extensionApi !== EXTENSION_API_VERSION || value.protocol !== CHAT_PROTOCOL_VERSION || typeof value.build !== "string" || !value.build) {
    throw new Error(t("core.error.incompatibleService"));
  }
  return value;
}

export async function validateChatOrigin(origin, timeoutMs = 3000) {
  const normalized = normalizeChatOrigin(origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalized}${EXTENSION_INFO_PATH}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(t("core.error.originCheck", { status: response.status }));
    return { origin: normalized, info: assertExtensionInfo(await response.json()) };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(t("core.error.originTimeout"));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
