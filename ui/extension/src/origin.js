export const EXTENSION_INFO_PATH = "/api/extension-info";
export const EXTENSION_API_VERSION = 1;
export const CHAT_PROTOCOL_VERSION = 3;

export function normalizeChatOrigin(value) {
  const url = new URL(String(value || "").trim());
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("只能填写不含路径、查询或账号信息的站点地址");
  }
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("服务地址必须使用 HTTPS；仅本机开发地址可使用 HTTP");
  }
  return url.origin;
}

export function permissionPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export function assertExtensionInfo(value) {
  if (!value || value.app !== "e2ee-chat" || value.extensionApi !== EXTENSION_API_VERSION || value.protocol !== CHAT_PROTOCOL_VERSION || typeof value.build !== "string" || !value.build) {
    throw new Error("该地址不是兼容的 E2EE Chat 服务");
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
    if (!response.ok) throw new Error(`服务检查失败：HTTP ${response.status}`);
    return { origin: normalized, info: assertExtensionInfo(await response.json()) };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("服务检查超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
