/*
  Banned addresses. Each ban is `{ ip, until, reason, at }` (`until` in ms since 1970, or null for good).
  Where the list is kept is up to `store`: `read()` returns the saved list (or null), `write(list)` saves
  it and returns false when it could not. With no store the list lives in memory only.
  Imports nothing, so the Node daemon (lib/bans.js, a file) and the Cloudflare Worker (its own storage)
  share it.
*/

/** One spelling per address: IPv4 seen through IPv6 (::ffff:1.2.3.4) is the IPv4 address. */
export const normalizeIp = (ip) => String(ip ?? "").trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1").toLowerCase();

export function createBanList({ store = null, now = Date.now } = {}) {
  let bans = new Map();
  let persistent = !!store;

  function load() {
    bans = new Map();
    const list = store?.read();
    for (const b of Array.isArray(list) ? list : []) if (b?.ip) bans.set(normalizeIp(b.ip), { ...b, ip: normalizeIp(b.ip) });
  }
  function save() {
    if (!store || !persistent) return;
    if (store.write([...bans.values()]) === false) persistent = false;
  }
  function expire() {
    let changed = false;
    for (const [ip, b] of bans) if (b.until !== null && b.until <= now()) { bans.delete(ip); changed = true; }
    if (changed) save();
  }

  load();
  return {
    load,
    isBanned(ip) {
      const b = bans.get(normalizeIp(ip));
      if (!b) return false;
      if (b.until !== null && b.until <= now()) { expire(); return false; }
      return true;
    },
    /** Ban `ip` for `minutes` (0 or none: for good). */
    ban(ip, { minutes = 0, reason = "" } = {}) {
      const key = normalizeIp(ip);
      if (!key) throw new Error("No address");
      const b = { ip: key, until: minutes > 0 ? now() + minutes * 60000 : null, reason: String(reason).slice(0, 200), at: now() };
      bans.set(key, b);
      save();
      return b;
    },
    unban(ip) {
      const had = bans.delete(normalizeIp(ip));
      if (had) save();
      return had;
    },
    list() { expire(); return [...bans.values()]; },
    get persistent() { return persistent; },
  };
}
