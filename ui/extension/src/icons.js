import { faHeadset } from "@fortawesome/free-solid-svg-icons";

export function headsetIcon(className = "") {
  const [width, height, , , path] = faHeadset.icon;
  return `<svg class="${className}" data-icon="headset" viewBox="0 0 ${width} ${height}" role="img" aria-hidden="true" focusable="false"><path fill="currentColor" d="${path}"></path></svg>`;
}
