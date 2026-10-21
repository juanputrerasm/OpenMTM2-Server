/*
  Which pages may connect to the room server. Browsers send the page's origin; native games send none.
  Shared by the Node daemon and the Cloudflare Worker, so it imports nothing.
*/

/** Whether a page's origin may connect under settings `{ origins, allowLocalOrigins, allowNoOrigin }`. */
export function originAllowed(origin, cfg) {
  if (!origin) return cfg.allowNoOrigin;
  if (cfg.origins.includes("*") || cfg.origins.includes(origin)) return true;
  if (!cfg.allowLocalOrigins) return false;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}
