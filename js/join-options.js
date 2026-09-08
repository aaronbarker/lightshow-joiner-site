/** Persist Upgrade / Convert / Reset checkboxes across visits. */

export const DEFAULT_JOIN_OPTIONS = Object.freeze({
  upgrade48to200: false,
  convert50to20: false,
  resetClosures: true,
});

export const JOIN_OPTIONS_COOKIE_NAME = "lsj-join-options";
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365;

export function normalizeJoinOptions(input) {
  const src = input && typeof input === "object" ? input : {};
  return {
    upgrade48to200:
      typeof src.upgrade48to200 === "boolean" ? src.upgrade48to200 : DEFAULT_JOIN_OPTIONS.upgrade48to200,
    convert50to20: typeof src.convert50to20 === "boolean" ? src.convert50to20 : DEFAULT_JOIN_OPTIONS.convert50to20,
    resetClosures: typeof src.resetClosures === "boolean" ? src.resetClosures : DEFAULT_JOIN_OPTIONS.resetClosures,
  };
}

export function serializeJoinOptions(options) {
  const o = normalizeJoinOptions(options);
  return `u${o.upgrade48to200 ? 1 : 0}_c${o.convert50to20 ? 1 : 0}_r${o.resetClosures ? 1 : 0}`;
}

export function parseJoinOptions(raw) {
  if (raw == null) return { ...DEFAULT_JOIN_OPTIONS };
  const text = String(raw).trim();
  if (!text) return { ...DEFAULT_JOIN_OPTIONS };
  const match = /^u([01])_c([01])_r([01])$/.exec(text);
  if (!match) return { ...DEFAULT_JOIN_OPTIONS };
  return {
    upgrade48to200: match[1] === "1",
    convert50to20: match[2] === "1",
    resetClosures: match[3] === "1",
  };
}

export function readCookieValue(cookieHeader, name = JOIN_OPTIONS_COOKIE_NAME) {
  if (cookieHeader == null || cookieHeader === "") return null;
  const parts = String(cookieHeader).split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export function readJoinOptionsFromCookie(cookieHeader) {
  try {
    const value = readCookieValue(cookieHeader, JOIN_OPTIONS_COOKIE_NAME);
    if (value == null) return { ...DEFAULT_JOIN_OPTIONS };
    return parseJoinOptions(value);
  } catch {
    return { ...DEFAULT_JOIN_OPTIONS };
  }
}

export function joinOptionsCookieString(options) {
  return `${JOIN_OPTIONS_COOKIE_NAME}=${serializeJoinOptions(options)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}; SameSite=Lax`;
}

export function writeJoinOptionsCookie(options, setter) {
  try {
    const encoded = joinOptionsCookieString(options);
    if (typeof setter === "function") {
      setter(encoded);
      return true;
    }
    if (typeof document !== "undefined" && document) {
      document.cookie = encoded;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function loadSavedJoinOptions(cookieHeader) {
  try {
    const header =
      cookieHeader !== undefined
        ? cookieHeader
        : typeof document !== "undefined" && document
          ? document.cookie
          : "";
    return readJoinOptionsFromCookie(header);
  } catch {
    return { ...DEFAULT_JOIN_OPTIONS };
  }
}
