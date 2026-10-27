#!/usr/bin/env node
// Can a teammate on this OpenCode 2.x actually reach Sidemates' tools? Starts a
// throwaway server in the folder given as the first argument (which holds the
// real deny-by-default settings), adds Sidemates' tool server exactly as a real
// run does, and asks the server's own rules what a teammate may call. No model
// is used and nothing is spent. Prints one JSON line: { ok, reason? }.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import { connectTools } from "./opencode-v2-tools.mjs";

const directory = realpathSync(process.argv[2] || ".");
const password = randomUUID();
const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
let server = null;

const finish = (result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  try { server?.kill("SIGTERM"); } catch { /* gone */ }
  setTimeout(() => process.exit(result.ok ? 0 : 1), 100);
};

const freePort = () => new Promise((done, fail) => {
  const probe = createServer();
  probe.on("error", fail);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => done(port)); });
});

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: directory, env: { ...process.env, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false;
  const seen = (chunk) => { if (String(chunk).includes(base)) up = true; };
  server.stdout.on("data", seen); server.stderr.on("data", seen);
  for (let i = 0; i < 80 && !up; i++) await new Promise((wake) => setTimeout(wake, 250));
  if (!up) return finish({ ok: false, reason: "OpenCode's server did not start." });

  const call = async (path, body, method = "POST") => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`${method} ${path.split("?")[0]} ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  try { await connectTools(call, directory); }
  catch { return finish({ ok: false, reason: "Sidemates' tool server did not connect to this OpenCode." }); }

  const session = await call("/api/session", { location: { directory }, agent: "openbot" });
  const sessionID = session?.data?.id;
  if (!sessionID) return finish({ ok: false, reason: "OpenCode did not start a session for the teammate." });
  // What the server decides for a tool call: the same rules a real run uses.
  const effect = async (action) => (await call(`/api/session/${sessionID}/permission`, { action, resources: ["*"], agent: "openbot" }))?.data?.effect;
  const expected = [["openbot_workspace_list", "allow"], ["openbot_workspace_write", "allow"], ["openbot_zz_future_runtime_tool", "deny"], ["execute", "deny"], ["shell", "deny"], ["figma_anything", "deny"]];
  for (const [action, want] of expected) {
    const got = await effect(action);
    if (got !== want) return finish({ ok: false, reason: `A teammate's call to “${action}” would be ${got ?? "unknown"}, not ${want}.` });
  }
  finish({ ok: true });
}

setTimeout(() => finish({ ok: false, reason: "The tool check took too long." }), 55_000).unref();
main().catch((error) => finish({ ok: false, reason: `The tool check could not run: ${String(error?.message || error).slice(0, 120)}` }));
