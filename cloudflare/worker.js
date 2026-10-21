/*
  OpenMTM2's room server as a Cloudflare Worker (docs/CLOUDFLARE.md): an optional way to host the
  online rooms on Cloudflare's free plan instead of running openmtm2d. Every request goes to one
  Durable Object, `RoomsObject`, which keeps every room in memory as openmtm2d does
  (cloudflare/edge-server.js) and the bans in its own storage.

  Settings are the Worker's variables (cloudflare/wrangler.toml): the OPENMTM2_* environment
  variables of docs/DAEMON.md, plus OPENMTM2_SETTINGS for any other setting (an object, or its JSON),
  plus OPENMTM2_LOCATION, a Durable Object location hint such as "enam" (eastern North America).
  The admin token is a secret: `npx wrangler secret put OPENMTM2_ADMIN_TOKEN`.
*/
import pkg from "../package.json" with { type: "json" };
import { createEdgeServer } from "./edge-server.js";
import { createLogger } from "../lib/log.js";
import { buildSettings } from "../lib/settings.js";

/** The Worker's variables as the room server's settings. Throws with a readable message on a bad value. */
export function workerSettings(env) {
  let json = env.OPENMTM2_SETTINGS ?? null;
  if (typeof json === "string") {
    try { json = JSON.parse(json); } catch (err) { throw new Error(`OPENMTM2_SETTINGS: ${err.message}`); }
  }
  // No DirectPlay gateway here: Cloudflare carries web traffic only.
  return buildSettings({ json, where: "OPENMTM2_SETTINGS", env, overrides: { gateway: false } });
}

const consoleLog = (settings) => createLogger({
  level: settings.logLevel,
  format: settings.logFormat,
  out: { write: (line) => console.log(line.trimEnd()) },
  err: { write: (line) => console.error(line.trimEnd()) },
});

/** The bans in the object's SQLite storage, one row. */
function sqlStore(sql, log) {
  sql.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return {
    read() {
      const rows = sql.exec("SELECT value FROM state WHERE key = 'bans'").toArray();
      try { return rows.length ? JSON.parse(rows[0].value) : null; } catch (err) { log("warn", "bans unreadable", { error: err.message }); return null; }
    },
    write(list) {
      try {
        sql.exec("INSERT OR REPLACE INTO state (key, value) VALUES ('bans', ?)", JSON.stringify(list));
        return true;
      } catch (err) {
        log("warn", "cannot save the bans; they are kept in memory only", { error: err.message });
        return false;
      }
    },
  };
}

/** Every room on this server. One object, so every player meets every room. */
export class RoomsObject {
  constructor(ctx, env) {
    try {
      const settings = workerSettings(env);
      const log = consoleLog(settings);
      this.edge = createEdgeServer({ settings, store: sqlStore(ctx.storage.sql, log), log, version: pkg.version });
      log("info", "started", { version: pkg.version, name: settings.name });
    } catch (err) {
      this.broken = err.message;
      console.error(JSON.stringify({ level: "error", msg: "cannot start", error: err.message }));
    }
  }

  fetch(request) {
    if (this.broken) return new Response(`The server's settings are wrong: ${this.broken}\n`, { status: 500 });
    return this.edge.fetch(request);
  }
}

export default {
  fetch(request, env) {
    const stub = env.ROOMS.get(env.ROOMS.idFromName("rooms"), env.OPENMTM2_LOCATION ? { locationHint: env.OPENMTM2_LOCATION } : undefined);
    return stub.fetch(request);
  },
};
