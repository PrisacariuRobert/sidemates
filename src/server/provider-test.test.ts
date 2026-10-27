// Hermetic connection-probe tests: stub runtimes are plain Node scripts, so no
// model runtime, account, or external request is needed. One live CLI test runs
// only when `opencode` is installed, and skips otherwise (CI verify has none).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROBE_TOKEN, probeAllowed, PROBE_COOLDOWN_MS, probeProviderModel } from "./provider-test.js";

const runtimeAvailable = (() => {
  try { return spawnSync("opencode", ["--version"], { timeout: 10_000 }).status === 0; }
  catch { return false; }
})();

test("connection probe passes when the runtime answers with the token", async () => {
  const script = `console.log(JSON.stringify({ type: "step_start", part: { messageID: "m1" } }));
console.log(JSON.stringify({ type: "text", part: { messageID: "m1", id: "p1" }, text: "chatter" }));
console.log(JSON.stringify({ type: "text", part: { messageID: "m1", id: "p1" }, text: "${PROBE_TOKEN}" }));
console.log(JSON.stringify({ type: "step_finish", part: { reason: "stop", messageID: "m1" } }));`;
  const result = await probeProviderModel("fixture/model", {}, (command, args, options) => spawn(process.execPath, ["--input-type=module", "-e", script], options));
  assert.equal(result.ok, true, result.error || "probe failed without an error message");
  assert.equal(result.model, "fixture/model");
  assert.equal(result.error, null);
  // A fresh receipt must fall inside its own cooldown, even for slow probes:
  // testedAt marks completion, not start.
  assert.equal(probeAllowed(result.testedAt), false, "A just-completed test must be inside its cooldown");
});

test("connection probe starts OpenCode in its own folder and passes no --dir (removed in OpenCode 2.x)", async () => {
  let seen: { args: string[]; cwd: string } | null = null;
  const script = `console.log(JSON.stringify({ type: "text", part: { messageID: "m1", id: "p1" }, text: "${PROBE_TOKEN}" }));`;
  await probeProviderModel("fixture/model", {}, (_command, args, options) => { seen = { args, cwd: String(options.cwd) }; return spawn(process.execPath, ["--input-type=module", "-e", script], options); });
  assert.ok(seen, "the probe launched a process");
  const { args, cwd } = seen as { args: string[]; cwd: string };
  assert.equal(args.includes("--dir"), false);
  assert.deepEqual(args.slice(0, 5), ["run", "--format", "json", "--model", "fixture/model"]);
  assert.ok(args.every((arg) => arg !== "--standalone") || args.includes("--standalone"), "standalone only appears when OpenCode supports it");
  assert.ok(path.basename(cwd).startsWith("openbot-provider-probe-"), cwd);
});

test("connection probe fails closed on a runtime error without leaking it", async () => {
  const script = `console.error("request failed: ECONNREFUSED 127.0.0.1:1"); process.exit(1);`;
  const result = await probeProviderModel("fixture/model", {}, (command, args, options) => spawn(process.execPath, ["--input-type=module", "-e", script], options));
  assert.equal(result.ok, false);
  assert.ok(result.error, "A failed probe must explain itself");
  assert.ok(!result.error!.includes("127.0.0.1"), "Probe errors must not echo endpoint addresses");
});

test("connection probe times out instead of hanging forever", async () => {
  const result = await probeProviderModel("any/model", {}, (_command, _args, options) => spawn("sleep", ["60"], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] }), 500);
  assert.equal(result.ok, false);
  assert.match(result.error || "", /timed out/i);
});

test("probe cooldown allows first tests and spaces repeats", () => {
  assert.equal(probeAllowed(null), true);
  const now = Date.now();
  assert.equal(probeAllowed(new Date(now - PROBE_COOLDOWN_MS - 1).toISOString(), now), true);
  assert.equal(probeAllowed(new Date(now - 1_000).toISOString(), now), false);
});

test("connection probe passes against a real configured endpoint", async (t) => {
  if (!runtimeAvailable) { t.skip("No model runtime on this host for the live CLI check."); return; }
  const { createServer } = await import("node:http");
  const root = mkdtempSync(path.join(tmpdir(), "openbot-probe-live-"));
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") { response.writeHead(404).end(); return; }
    let input = "";
    for await (const chunk of request) input += String(chunk);
    const body = JSON.parse(input);
    const completion = { id: "probe", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: PROBE_TOKEN }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
    if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(completion)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", usage: undefined, choices: [{ index: 0, delta: { role: "assistant", content: PROBE_TOKEN }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const { apiRuntimeEnvironment } = await import("../shared/provider-config.js");
    const home = path.join(root, "home");
    const result = await probeProviderModel("openbot-probe-live/probe-model", {
      ...apiRuntimeEnvironment({ id: "probe-live", ownerId: "fixture", provider: "custom", name: "Probe endpoint", authMode: "api_key", runtime: "opencode", envName: null, hasSecret: true, createdAt: "", updatedAt: "", apiConfig: { baseUrl: `http://127.0.0.1:${port}/v1`, protocol: "openai-compatible", modelIds: ["probe-model"] } }, "fixture-only-key"),
      HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"),
    });
    assert.equal(result.ok, true, result.error || "live CLI probe failed");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
