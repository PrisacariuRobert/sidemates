import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const wrapper = new URL("./opencode-live.mjs", import.meta.url).pathname;

/** A stand-in `opencode` on PATH. `serve` prints its address the way the real one does,
 * then behaves like the scenario says; `run` prints one result line and records its arguments. */
function fakeOpenCode(scenario: "web-app" | "stream-closes") {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-opencode-"));
  const bin = path.join(dir, "bin"); mkdirSync(bin);
  const log = path.join(dir, "run-args.json");
  writeFileSync(path.join(bin, "opencode"), `#!/usr/bin/env node
const { createServer } = require("node:http");
const { writeFileSync } = require("node:fs");
const [command, ...rest] = process.argv.slice(2);
if (command === "serve") {
  const port = Number(rest[rest.indexOf("--port") + 1]);
  const server = createServer((request, response) => {
    if (${JSON.stringify(scenario)} === "web-app") { // OpenCode 2.x: no old endpoints, the web app answers everything
      if (request.method === "POST") { response.writeHead(405).end(); return; }
      response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>OpenCode</title>"); return;
    }
    if (request.url.startsWith("/event")) { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(); return; }
    // a session request that never answers
  });
  server.listen(port, "127.0.0.1", () => console.log("server listening on http://127.0.0.1:" + port));
} else if (command === "run") {
  writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({ type: "text", part: { id: "p1", messageID: "m1", type: "text", text: "plain run answer", time: { start: 1, end: 2 } } }));
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
  const args = JSON.parse(readFileSync(fake.log, "utf8")) as string[];
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
