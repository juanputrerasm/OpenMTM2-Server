/*
  The daemon's settings from a JSON file, the environment and the command line (docs/DAEMON.md). The
  defaults and checks are in lib/settings.js.
*/
import { readFileSync } from "node:fs";
import { buildSettings, DAEMON_PORT } from "./settings.js";

export { DAEMON_PORT, DEFAULTS, ENV, redact } from "./settings.js";

const FLAGS = {
  "--host": "host", "--port": "port", "--name": "name", "--motd": "motd", "--origin": "origins", "--max-rooms": "maxRooms",
  "--max-players": "maxPlayers", "--log-level": "logLevel", "--log-format": "logFormat", "--admin-token": "adminToken",
  "--state-dir": "stateDir", "--cert": "cert", "--key": "key", "--drain": "drainS", "--gateway-bind": "gatewayBind",
};
const SWITCHES = { "--trust-proxy": "trustProxy", "--gateway": "gateway" };

export const USAGE = `usage: openmtm2d [--config server.json] [--host 0.0.0.0] [--port ${DAEMON_PORT}] [--name text] [--motd text]
                 [--origin https://site] [--max-rooms n] [--max-players 2-16] [--state-dir dir] [--admin-token text]
                 [--log-level debug|info|warn|error] [--log-format json|text] [--trust-proxy] [--cert file --key file]
                 [--drain seconds] [--gateway [--gateway-bind address]] [--print-config] [--version]`;

/** The command line: `{ configFile, overrides, printConfig, help, version }`. */
export function parseArgs(argv) {
  const out = { configFile: null, overrides: {}, printConfig: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "-c") out.configFile = argv[++i];
    else if (a === "--print-config") out.printConfig = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (SWITCHES[a]) out.overrides[SWITCHES[a]] = true;
    else if (FLAGS[a]) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      const key = FLAGS[a];
      if (key === "origins") out.overrides.origins = [...(out.overrides.origins ?? []), v];
      else out.overrides[key] = v;
    } else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

/**
 * The effective settings. `file` is a JSON file's path (or null), `env` the environment, `overrides` from the command
 * line. Throws with a readable message on a bad value.
 */
export function loadConfig({ file = null, env = process.env, overrides = {} } = {}) {
  let json = null;
  if (file) {
    try { json = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`${file}: ${err.message}`); }
  }
  return buildSettings({ json, where: file ?? "settings", env, overrides });
}
