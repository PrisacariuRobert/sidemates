import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const wrapper = new URL("./opencode-live.mjs", import.meta.url).pathname;

/** A stand-in `opencode` on PATH. `serve` prints its address the way the real one does,
 * then behaves like the scenario says; `run` prints one result line and records its arguments. */
function fakeOpenCode(scenario: "web-app" | "stream-closes" | "v2") {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-opencode-"));
  const bin = path.join(dir, "bin"); mkdirSync(bin);
  const log = path.join(dir, "run-args.json");
  writeFileSync(path.join(bin, "opencode"), `#!/usr/bin/env node
const { createServer } = require("node:http");
const { writeFileSync } = require("node:fs");
const [command, ...rest] = process.argv.slice(2);
if (command === "serve") {
  const port = Number(rest[rest.indexOf("--port") + 1]);
  const secret = process.env.OPENCODE_PASSWORD || "";
  const authorised = (request) => request.headers.authorization === "Basic " + Buffer.from("opencode:" + secret).toString("base64");
  const server = createServer((request, response) => {
    if (${JSON.stringify(scenario)} === "v2") { // OpenCode 2.x: /api/*, password required, text events on /api/event
      if (!authorised(request)) { response.writeHead(401, { "content-type": "application/json" }).end('{"_tag":"UnauthorizedError"}'); return; }
      if (request.url === "/api/info") { response.writeHead(200, { "content-type": "application/json" }).end('{"version":"2.9.9","pid":1}'); return; }
      if (request.url.startsWith("/api/event")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const data = { sessionID: "ses_fake", assistantMessageID: "msg_fake", ordinal: 0 };
        setTimeout(() => {
          response.write("data: " + JSON.stringify({ type: "session.text.started", data }) + "\\n\\n");
          response.write("data: " + JSON.stringify({ type: "session.text.delta", data: { ...data, delta: "streamed words" } }) + "\\n\\n");
          response.write("data: " + JSON.stringify({ type: "session.text.ended", data: { ...data, text: "streamed words" } }) + "\\n\\n");
        }, 150);
        return;
      }
      response.writeHead(404).end(); return;
    }
    if (${JSON.stringify(scenario)} === "web-app") { // OpenCode 2.x: no old endpoints, the web app answers everything
      if (request.method === "POST") { response.writeHead(405).end(); return; }
      response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>OpenCode</title>"); return;
    }
    if (request.url.startsWith("/event")) { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(); return; }
    // a session request that never answers
  });
  server.listen(port, "127.0.0.1", () => console.log("server listening on http://127.0.0.1:" + port));
} else if (command === "run") {
  writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), password: process.env.OPENCODE_PASSWORD || null }));
  const answer = () => console.log(JSON.stringify({ type: "text", sessionID: "ses_fake", part: { id: "p1", messageID: "m1", type: "text", text: "plain run answer", time: { start: 1, end: 2 } } }));
  if (rest.includes("--server")) setTimeout(answer, 700); else answer();
}
`);
  chmodSync(path.join(bin, "opencode"), 0o755);
  return { bin, log, dir };
}
const runWrapper = (bin: string, cwd: string) => spawnSync(process.execPath, [wrapper, "run", "--auto", "--format", "json", "--model", "prov/model", "--agent", "openbot", "--title", "T", "hello"], {
  cwd, encoding: "utf8", timeout: 40_000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
});

test("a newer OpenCode whose server answers with its web app is run the plain way, not ended silently", () => {
  const fake = fakeOpenCode("web-app");
  const result = runWrapper(fake.bin, fake.dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /plain run answer/, "the plain run's answer reached the caller");
  const args = (JSON.parse(readFileSync(fake.log, "utf8")) as { args: string[] }).args;
  assert.deepEqual(args.slice(0, 3), ["run", "--auto", "--format"]);
  assert.ok(!args.includes("--dir"));
});

test("an event stream that closes before the task starts is reported, never treated as a finished task", () => {
  const fake = fakeOpenCode("stream-closes");
  const result = runWrapper(fake.bin, fake.dir);
  assert.equal(result.status, 1, "not a silent success");
  assert.match(result.stdout, /"type":"error"/);
  assert.match(result.stdout, /stopped before the task started/);
});

test("OpenCode 2.x: replies stream live through its own API, results pass through, and the server password is used", () => {
  const fake = fakeOpenCode("v2");
  const result = runWrapper(fake.bin, fake.dir);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { type: string; event?: { type: string; properties: Record<string, any> }; part?: { text: string } });
  const live = lines.filter((line) => line.type === "openbot.opencode_event").map((line) => line.event!);
  assert.deepEqual(live.map((event) => event.type), ["message.part.updated", "message.part.delta", "message.part.updated"], "text started, streamed, finished");
  assert.equal(live[1]!.properties.delta, "streamed words");
  assert.equal(live[1]!.properties.partID, live[0]!.properties.part.id, "the streamed words belong to the part that started");
  assert.equal(lines.find((line) => line.type === "text")!.part!.text, "plain run answer", "the real result passes through untouched");
  const ran = JSON.parse(readFileSync(fake.log, "utf8")) as { args: string[]; password: string | null };
  assert.ok(ran.args.includes("--server") && /^http:\/\/127\.0\.0\.1:\d+$/.test(ran.args[ran.args.indexOf("--server") + 1]!), "run is attached to the private server");
  assert.ok(!ran.args.includes("--standalone") && !ran.args.includes("--dir"));
  assert.ok(ran.password && ran.password.length > 20, "the run was given the server's password; the fake server refused anyone without it");
});

