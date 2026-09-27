export const MAX_CUSTOM_CSS_BYTES = 100 * 1024;
import { t } from "../../src/i18n.js";
const STYLE_ID = "e2ee-chat-custom-css";

export function validateCustomCss(css, byteLength, fileName = "custom.css") {
  if (!String(fileName).toLowerCase().endsWith(".css")) throw new Error(t("core.error.cssExtension"));
  if (!Number.isFinite(byteLength) || byteLength < 1) throw new Error(t("core.error.cssEmpty"));
  if (byteLength > MAX_CUSTOM_CSS_BYTES) throw new Error(t("core.error.cssTooLarge"));
  return String(css || "");
}

export function setCustomCss(css) {
  let style = document.getElementById(STYLE_ID);
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  style.textContent = css;
}

export async function installCustomCss() {
  const { customCss = "" } = await chrome.storage.local.get("customCss");
  setCustomCss(customCss);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.customCss) setCustomCss(changes.customCss.newValue || "");
  });
}
