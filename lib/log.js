/*
  Log lines for a daemon: one per event, JSON (default) or plain text, to stdout; warnings and
  errors to stderr. journald and docker logs collect both.
*/
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = "info", format = "json", out = process.stdout, err = process.stderr, now = () => new Date() } = {}) {
  let min = LEVELS[level] ?? LEVELS.info;
  let fmt = format;
  const log = (lvl, msg, fields = {}) => {
    if ((LEVELS[lvl] ?? 0) < min) return;
    const line = fmt === "json"
      ? JSON.stringify({ t: now().toISOString(), level: lvl, msg, ...fields })
      : `${lvl.toUpperCase()} ${msg}${Object.entries(fields).map(([k, v]) => ` ${k}=${typeof v === "string" && !/\s/.test(v) ? v : JSON.stringify(v)}`).join("")}`;
    (LEVELS[lvl] >= LEVELS.warn ? err : out).write(`${line}\n`);
  };
  log.setLevel = (l) => { min = LEVELS[l] ?? min; };
  log.setFormat = (f) => { fmt = f; };
  return log;
}
