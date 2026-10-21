/*
  openmtm2d as a process, as systemd runs it: a config file and a state folder, /healthz and
  /status, SIGHUP reloads, SIGTERM tells everyone and exits 0, a ban survives a restart.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./helpers/ws-client.mjs";

const BIN = fileURLToPath(new URL("../bin/openmtm2d.mjs", import.meta.url));

function run(configFile) {
  const child = spawn(process.execPath, [BIN, "--config", configFile], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  const lines = [];
  let buf = "";
  const waiters = [];
  const onData = (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      lines.push(line);
      for (const w of [...waiters]) if (w.test(line)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(line); }
    }
  };
  child.stdout.setEncoding("utf8").on("data", onData);
  child.stderr.setEncoding("utf8").on("data", onData);
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return {
    child, lines, exited,
    waitFor(msg, ms = 5000) {
      const found = lines.find((l) => l.msg === msg);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no "${msg}" in ${JSON.stringify(lines)}`)), ms);
        const w = { test: (l) => l.msg === msg, resolve: (l) => { clearTimeout(timer); resolve(l); } };
        waiters.push(w);
      });
    },
  };
}

test("the daemon: config file, health, reload, drain, bans kept across a restart", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "openmtm2d-proc-"));
  const port = 48400 + Math.floor(Math.random() * 400);
  const configFile = join(dir, "server.json");
  const config = { host: "127.0.0.1", port, name: "Test server", motd: "first", stateDir: join(dir, "state"), adminToken: "tok", drainS: 5, logLevel: "info" };
  writeFileSync(configFile, JSON.stringify(config));
  const base = `http://127.0.0.1:${port}`;
  try {
    // --print-config hides the token.
    const printed = spawnSync(process.execPath, [BIN, "--config", configFile, "--print-config"], { encoding: "utf8" });
    assert.equal(printed.status, 0);
    assert.equal(JSON.parse(printed.stdout).adminToken, "(set)");
    const bad = spawnSync(process.execPath, [BIN, "--max-players", "40"], { encoding: "utf8" });
    assert.equal(bad.status, 2);

    let d = run(configFile);
    await d.waitFor("listening");
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await (await fetch(`${base}/status`)).json()).motd, "first");

    // SIGHUP: new settings without a restart.
    writeFileSync(configFile, JSON.stringify({ ...config, motd: "second" }));
    d.child.kill("SIGHUP");
    await d.waitFor("reloaded");
    assert.equal((await (await fetch(`${base}/status`)).json()).motd, "second");

    // A ban, written to the state folder.
    const banned = await fetch(`${base}/admin/bans`, { method: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify({ ip: "203.0.113.9", reason: "test" }) });
    assert.equal(banned.status, 200);

    // SIGTERM with a player connected: they are told, then closed with 1001, and the process exits 0.
    const ws = await connect(`ws://127.0.0.1:${port}/play`);
    ws.json({ type: "hello", id: 1, protocol: 1, name: "Ann" });
    await ws.next((m) => m.json?.id === 1);
    d.child.kill("SIGTERM");
    assert.equal((await ws.next((m) => m.json?.type === "shutdown")).json.type, "shutdown");
    assert.equal((await ws.closed).code, 1001);
    assert.deepEqual(await d.exited, { code: 0, signal: null });

    // Restarted: the ban is still there.
    d = run(configFile);
    await d.waitFor("listening");
    const bans = await (await fetch(`${base}/admin/bans`, { headers: { authorization: "Bearer tok" } })).json();
    assert.deepEqual(bans.bans.map((b) => b.ip), ["203.0.113.9"]);
    assert.equal(bans.persistent, true);
    d.child.kill("SIGINT");
    assert.equal((await d.exited).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
