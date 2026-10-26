/*
  The room server's settings (docs/DAEMON.md): the defaults, what each environment variable sets, and
  the checks. Imports nothing, so the Node daemon (lib/config.js) and the Cloudflare Worker share it.
*/
export const DAEMON_PORT = 47660;

export const DEFAULTS = Object.freeze({
  host: "0.0.0.0",
  port: DAEMON_PORT,
  name: "OpenMTM2 server",
  motd: "",
  // Pages allowed to connect (browsers send their origin). "*" allows any page.
  origins: ["https://juanputrerasm.github.io"],
  // Pages served from the visitor's own computer (development builds).
  allowLocalOrigins: true,
  // Clients that send no Origin at all: native games such as Community Patch 3.
  allowNoOrigin: true,
  maxRooms: 50,
  maxPlayers: 8,
  maxMembers: 200,
  maxConnectionsPerIp: 8,
  connectionsPerMinutePerIp: 30,
  messagesPerSecond: 20,
  chatPerSecond: 2,
  loadTimeoutS: 120,
  resultsTimeoutS: 30,
  // A connection silent this long is dropped, and its player leaves their room (0: never).
  idleTimeoutS: 120,
  startDelayMs: 1500,
  drainS: 60,
  logLevel: "info",
  logFormat: "json",
  adminToken: "",
  stateDir: "/var/lib/openmtm2",
  // Behind a reverse proxy: take the client's address from X-Forwarded-For.
  trustProxy: false,
  cert: "",
  key: "",
  // The DirectPlay gateway (docs/GATEWAY.md): classic rooms that Monster Truck Madness 2 itself joins.
  gateway: false,
  gatewayBind: "0.0.0.0",
  maxGatewayRooms: 1,
  gatewayEnumPort: 47624,
  gatewayTcpPorts: [2300, 2350],
  gatewayUdpPorts: [2350, 2400],
});

const NUMBERS = ["port", "maxGatewayRooms", "gatewayEnumPort", "maxRooms", "maxPlayers", "maxMembers", "maxConnectionsPerIp", "connectionsPerMinutePerIp", "messagesPerSecond", "chatPerSecond", "loadTimeoutS", "resultsTimeoutS", "idleTimeoutS", "startDelayMs", "drainS"];
const BOOLEANS = ["allowLocalOrigins", "allowNoOrigin", "trustProxy", "gateway"];
const RANGES = ["gatewayTcpPorts", "gatewayUdpPorts"];
const LEVELS = ["debug", "info", "warn", "error"];

/** Environment variables and the setting each sets. */
export const ENV = Object.freeze({
  OPENMTM2_HOST: "host", OPENMTM2_PORT: "port", OPENMTM2_NAME: "name", OPENMTM2_MOTD: "motd", OPENMTM2_ORIGINS: "origins",
  OPENMTM2_MAX_ROOMS: "maxRooms", OPENMTM2_MAX_PLAYERS: "maxPlayers", OPENMTM2_LOG_LEVEL: "logLevel", OPENMTM2_LOG_FORMAT: "logFormat",
  OPENMTM2_ADMIN_TOKEN: "adminToken", OPENMTM2_STATE_DIR: "stateDir", OPENMTM2_TRUST_PROXY: "trustProxy",
  OPENMTM2_CERT: "cert", OPENMTM2_KEY: "key", OPENMTM2_GATEWAY: "gateway", OPENMTM2_GATEWAY_BIND: "gatewayBind",
  // systemd's StateDirectory= sets this one.
  STATE_DIRECTORY: "stateDir",
});

export function coerce(key, value, where) {
  if (NUMBERS.includes(key)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${where}: ${key} must be a number`);
    return n;
  }
  if (BOOLEANS.includes(key)) {
    if (typeof value === "boolean") return value;
    if (/^(1|true|yes|on)$/i.test(String(value))) return true;
    if (/^(0|false|no|off)$/i.test(String(value))) return false;
    throw new Error(`${where}: ${key} must be true or false`);
  }
  if (RANGES.includes(key)) {
    const r = Array.isArray(value) ? value.map(Number) : String(value).split("-").map(Number);
    if (r.length !== 2 || !r.every((n) => Number.isInteger(n) && n > 0 && n < 65536) || r[0] > r[1]) throw new Error(`${where}: ${key} must be a port range such as 2300-2350`);
    return r;
  }
  if (key === "origins") return Array.isArray(value) ? value.map(String) : String(value).split(",").map((s) => s.trim()).filter(Boolean);
  return String(value);
}

/**
 * The defaults, then a settings file's JSON (`json`, named `where` in errors), then the environment
 * (`env`), then `overrides`, each overriding the one before. Throws with a readable message on a bad value.
 */
export function buildSettings({ json = null, where = "settings", env = {}, overrides = {} } = {}) {
  const cfg = { ...DEFAULTS, origins: [...DEFAULTS.origins] };
  for (const [k, v] of Object.entries(json ?? {})) {
    if (k.startsWith("//") || k === "$comment") continue;
    if (!(k in DEFAULTS)) throw new Error(`${where}: unknown setting ${k}`);
    cfg[k] = coerce(k, v, where);
  }
  for (const [name, key] of Object.entries(ENV)) if (env[name] !== undefined && env[name] !== "") cfg[key] = coerce(key, env[name], name);
  for (const [k, v] of Object.entries(overrides)) cfg[k] = coerce(k, v, "command line");
  // Checks.
  if (!(cfg.port >= 1 && cfg.port <= 65535 && Number.isInteger(cfg.port))) throw new Error("port must be 1 to 65535");
  if (!(cfg.maxPlayers >= 2 && cfg.maxPlayers <= 16)) throw new Error("maxPlayers must be 2 to 16");
  if (!LEVELS.includes(cfg.logLevel)) throw new Error(`logLevel must be one of ${LEVELS.join(", ")}`);
  if (!["json", "text"].includes(cfg.logFormat)) throw new Error("logFormat must be json or text");
  if (!!cfg.cert !== !!cfg.key) throw new Error("cert and key go together");
  return cfg;
}

/** The settings with secrets hidden, for --print-config and /status. */
export const redact = (cfg) => ({ ...cfg, adminToken: cfg.adminToken ? "(set)" : "" });
