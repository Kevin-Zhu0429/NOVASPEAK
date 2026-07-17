import path from "node:path";

export const DESKTOP_UPDATE_PUBLIC_PATH = "/desktop-updates";

export function resolveDesktopUpdateDirectory({ env = process.env, serverDirectory } = {}) {
  const configured = typeof env.DESKTOP_UPDATE_DIR === "string" ? env.DESKTOP_UPDATE_DIR.trim() : "";
  if (configured) return path.resolve(configured);
  return path.join(serverDirectory, "data", "desktop-updates");
}

export function isAllowedDesktopUpdateAsset(requestPath) {
  if (typeof requestPath !== "string") return false;
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return false;
  }
  if (!/^\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(decoded)) return false;
  if (decoded.includes("..")) return false;
  return /\.(?:yml|exe|blockmap)$/i.test(decoded);
}

export function setDesktopUpdateResponseHeaders(response, filePath) {
  const isManifest = path.basename(filePath).toLowerCase().endsWith(".yml");
  response.setHeader("Cache-Control", isManifest
    ? "no-store, max-age=0"
    : "public, max-age=31536000, immutable");
  response.setHeader("X-Content-Type-Options", "nosniff");
}
