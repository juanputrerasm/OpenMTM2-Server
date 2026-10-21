/*
  The daemon's bans, kept in `<stateDir>/bans.json` so they survive a restart (the list itself is
  lib/ban-list.js). When the state folder cannot be written the list lives in memory only, and the
  daemon says so.
*/
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBanList, normalizeIp } from "./ban-list.js";

export { normalizeIp };

export function createBans({ stateDir = null, now = Date.now, log = () => {} } = {}) {
  const file = stateDir ? join(stateDir, "bans.json") : null;
  const store = file && {
    read() {
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        if (err.code !== "ENOENT") log("warn", "bans file unreadable", { file, error: err.message });
        return null;
      }
    },
    write(list) {
      try {
        mkdirSync(stateDir, { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
        renameSync(tmp, file);
        return true;
      } catch (err) {
        log("warn", "cannot write the state folder; bans are kept in memory only", { stateDir, error: err.message });
        return false;
      }
    },
  };
  return createBanList({ store, now });
}
