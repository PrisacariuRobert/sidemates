#!/usr/bin/env node
// Live replies for OpenCode. Drop-in for `opencode run --format json …`:
// it starts a private per-task `opencode serve`, sends the same prompt through
// the server's API, and prints the same JSON lines `run` prints (step_start,
// text, tool_use, step_finish, error) — plus display-only
// {"type":"openbot.opencode_event"} lines with streaming text.
//
// Why not `run --attach`? Its client exits after the first tool step while
// the server keeps working (OpenCode 1.18.31–32), which would drop answers.
//
// - The server gets this task's environment (its scoped tool token), a random
//   password (environment only, never argv) and a random loopback port.
// - `--auto` answers permission requests "once", as `run --auto` does;
//   questions are declined, as in non-interactive `run`.
// - When the session goes idle, saved messages are re-read so nothing the
//   event stream missed is lost.
// - Anything unexpected falls back to plain `opencode run` with the same args.
// All processes share one process group: stopping the task stops them all.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { basename, extname, resolve } from "node:path";

const argv = process.argv.slice(2);
const children = new Set();
let exiting = false, sessionId = null, base = null;
const auth = { authorization: "" };

const write = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
const stopAll = (signal = "SIGTERM") => { for (const child of children) { try { child.kill(signal); } catch { /* gone */ } } };
// How to ask the server to stop the running session; set once the server's generation is known.
let abortRemote = () => sessionId && base ? fetch(`${base}/session/${sessionId}/abort`, { method: "POST", headers: auth, signal: AbortSignal.timeout(1_500) }).catch(() => {}) : Promise.resolve();
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {
  exiting = true;
  const abort = abortRemote();
  void abort.finally(() => { stopAll(signal); process.exit(143); });
  setTimeout(() => { stopAll("SIGKILL"); process.exit(143); }, 3_000).unref();
});

/** Only the argument shapes Sidemates sends; anything else runs plain `run`. */
function parse(args) {
  if (args[0] !== "run") return null;
  const out = { auto: false, files: [] };
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--auto" || arg === "--standalone") { if (arg === "--auto") out.auto = true; }
    else if (arg === "--format") { if (rest[++i] !== "json") return null; }
    else if (["--model", "--dir", "--agent", "--session", "--title", "--file"].includes(arg)) {
      const value = rest[++i];
      if (value === undefined) return null;
      if (arg === "--file") out.files.push(value); else out[arg.slice(2)] = value;
    } else if (arg.startsWith("-")) return null;
    else if (i === rest.length - 1) out.prompt = arg;
    else return null;
  }
  if (!out.prompt || !out.model || !out.model.includes("/")) return null;
  // OpenCode 2.x has no --dir: the working folder is the project.
  out.dir ||= process.cwd();
  return out;
}

function plainRun() {
  const child = spawn("opencode", argv, { env: process.env, stdio: ["ignore", "inherit", "inherit"] });
  children.add(child);
  child.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
  child.on("close", (code, signal) => { children.delete(child); process.exit(exiting ? 143 : signal ? 1 : code ?? 1); });
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => done(port)); });
  });
}

function startServer(env) {
  return new Promise((done) => {
    void freePort().then((port) => {
      const serve = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
      children.add(serve);
      let seen = "", settled = false;
      const finish = (url) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (!url) { children.delete(serve); try { serve.kill("SIGTERM"); } catch { /* gone */ } }
        done(url);
      };
      const inspect = (chunk) => { seen = (seen + String(chunk)).slice(-4_000); if (seen.includes(`http://127.0.0.1:${port}`)) finish(`http://127.0.0.1:${port}`); };
      serve.stdout.on("data", inspect); serve.stderr.on("data", inspect);
      serve.on("error", () => finish(null));
      serve.on("close", () => { children.delete(serve); if (!settled) finish(null); else if (!exiting) failed("The OpenCode server stopped unexpectedly."); });
      const timer = setTimeout(() => finish(null), 10_000);
    }, () => done(null));
  });
}

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json" };
const mimeFor = (file) => MIME[extname(file).toLowerCase()] || "text/plain";

class Rejected extends Error {}
async function api(path, body, method = "POST") {
  // Generous: a busy Mac can take a while, and the task has its own limits.
  const response = await fetch(`${base}${path}`, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Rejected(`OpenCode ${method} ${path.replace(/ses_\w+/, "…")} → ${response.status} ${(await response.text()).slice(0, 300)}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

let finished = false, sawWork = false, hadError = false;
const emitted = new Set();
// Messages that existed before this prompt (a continued session) are never ours to print.
const earlier = new Set();
function failed(message) {
  if (finished) return;
  write({ type: "error", timestamp: Date.now(), sessionID: sessionId, error: { name: "UnknownError", data: { message } } });
  hadError = true;
  void done();
}

/** OpenCode retries a full allowance forever. Free tiers often limit each
 * minute, so short waits are shown and allowed; a long wait, or several in a
 * row, means the allowance is used up: stop and say so instead of spinning. */
let quotaRetries = 0, abortSession = () => {};
function quotaRetry(status) {
  const message = String(status.message || "");
  if (!/quota|rate.?limit|resource.?exhausted|too many requests|429/i.test(message)) return;
  quotaRetries += 1;
  const wait = Number(/retry in ([\d.]+)\s*s/i.exec(message)?.[1]) || (typeof status.next === "number" ? Math.max(0, (status.next - Date.now()) / 1000) : 60);
  if (quotaRetries <= 5 && wait <= 120 && !/per.?day|daily/i.test(message)) {
    write({ type: "openbot.waiting", timestamp: Date.now(), sessionID: sessionId, seconds: Math.ceil(wait) });
    return;
  }
  abortSession();
  if (finished) return;
  write({ type: "error", timestamp: Date.now(), sessionID: sessionId, error: { name: "APIError", data: { statusCode: 429, message: message.slice(0, 2000) } } });
  hadError = true;
  void done();
}

/** Print a part exactly once, in `run --format json` shape, when complete. */
function emitPart(part) {
  if (!part || part.sessionID !== sessionId || emitted.has(part.id) || earlier.has(part.messageID)) return;
  // (Callers pass assistant parts only: live events are routed by role, and
  // the final re-read reads assistant messages.)
  let type = null;
  if (part.type === "step-start") type = "step_start";
  else if (part.type === "step-finish") type = "step_finish";
  else if (part.type === "text" && part.time?.end && !part.synthetic) type = "text";
  else if (part.type === "tool" && ["completed", "error"].includes(part.state?.status)) type = "tool_use";
  if (!type) return;
  emitted.add(part.id);
  sawWork = true;
  write({ type, timestamp: Date.now(), sessionID: sessionId, part });
}

async function done() {
  if (finished) return;
  finished = true;
  // Reconcile with what the server saved: nothing the stream missed is lost.
  try {
    const messages = await api(`/session/${sessionId}/message`, undefined, "GET");
    for (const message of messages || []) if (message.info?.role === "assistant") for (const part of message.parts || []) emitPart(part);
  } catch { /* The live stream already delivered what it could. */ }
  stopAll();
  process.exit(hadError ? 1 : 0);
}

/** The event stream closed. After a prompt was sent that means the work is over;
 * before that nothing ran, so say so instead of exiting as if it had succeeded. */
let promptSent = false;
function ended() {
  if (promptSent) return done();
  if (finished) return;
  finished = true;
  // Nothing was sent, so there is nothing to reconcile: report it and stop.
  write({ type: "error", timestamp: Date.now(), sessionID: sessionId, error: { name: "UnknownError", data: { message: "OpenCode stopped before the task started." } } });
  stopAll();
  process.exit(1);
}

async function subscribe(signal, onEvent) {
  const response = await fetch(`${base}/event`, { headers: auth, signal });
  if (!response.ok || !response.body) throw new Error("The OpenCode event stream did not open.");
  // A newer OpenCode can answer this address with its web app instead of an
  // event stream. That is not a stream: reading it would end at once and look
  // like a finished task with no answer. Only a real stream counts.
  if (!/text\/event-stream/i.test(response.headers.get("content-type") || "")) throw new Error("The OpenCode server did not offer the expected event stream.");
  const decoder = new TextDecoder();
  let buffer = "";
  (async () => {
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip a malformed event */ }
        }
      }
      if (!finished && !exiting) void ended();
    } catch { if (!finished && !exiting) void ended(); }
  })();
}

function fallBack(stream) {
  stream.abort();
  finished = true;
  for (const child of [...children]) { children.delete(child); try { child.kill("SIGTERM"); } catch { /* gone */ } }
  plainRun();
}

/** OpenCode 2.x: a different server API (under /api, new event names, the
 * password in OPENCODE_PASSWORD). `opencode run --server` still does the work and
 * prints the usual result lines, so those are passed through untouched. The only
 * thing added here is live text: the event stream's text updates are turned into
 * the display-only lines Sidemates already shows. */
async function isOpenCode2() {
  try {
    const response = await fetch(`${base}/api/info`, { headers: auth, signal: AbortSignal.timeout(4_000) });
    if (!response.ok || !/json/i.test(response.headers.get("content-type") || "")) return false;
    return typeof (await response.json())?.version === "string";
  } catch { return false; }
}

/** Event stream (2.x names) -> the shape the live-text collector reads. */
function liveFromV2(event) {
  const data = event?.data || {};
  const message = data.assistantMessageID;
  if (!message || (data.sessionID && sessionId && data.sessionID !== sessionId)) return null;
  const partID = `${message}:text:${data.ordinal ?? 0}`;
  if (event.type === "session.text.started") return { type: "message.part.updated", properties: { part: { id: partID, messageID: message, type: "text", text: "" } } };
  if (event.type === "session.text.delta" && typeof data.delta === "string") return { type: "message.part.delta", properties: { partID, messageID: message, field: "text", delta: data.delta } };
  if (event.type === "session.text.ended" && typeof data.text === "string") return { type: "message.part.updated", properties: { part: { id: partID, messageID: message, type: "text", text: data.text } } };
  return null;
}

async function watchV2(signal) {
  try {
    const response = await fetch(`${base}/api/event`, { headers: { ...auth, accept: "text/event-stream" }, signal });
    // Live text is a bonus. If the stream is not a real one, the run goes on without it.
    if (!response.ok || !response.body || !/text\/event-stream/i.test(response.headers.get("content-type") || "")) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const event = JSON.parse(line.slice(5).trim());
          if (!sessionId && event?.data?.sessionID && ["session.created", "session.execution.started"].includes(event.type)) sessionId = event.data.sessionID;
          const live = liveFromV2(event);
          if (live) write({ type: "openbot.opencode_event", event: live });
        } catch { /* skip an unreadable event */ }
      }
    }
  } catch { /* the stream ended or was stopped */ }
}

async function runV2(password) {
  abortRemote = () => sessionId ? fetch(`${base}/api/session/${sessionId}/interrupt`, { method: "POST", headers: auth, signal: AbortSignal.timeout(1_500) }).catch(() => {}) : Promise.resolve();
  const stream = new AbortController();
  void watchV2(stream.signal);
  // The same arguments the plain run would get, pointed at this private server.
  const args = ["run", "--server", base, ...argv.slice(1).filter((arg) => arg !== "--standalone")];
  const child = spawn("opencode", args, { env: { ...process.env, OPENCODE_PASSWORD: password }, stdio: ["ignore", "pipe", "inherit"] });
  children.add(child);
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { const event = JSON.parse(line); if (!sessionId && event?.sessionID) sessionId = event.sessionID; } catch { /* not a result line */ }
      write(line);
    }
  });
  child.on("error", (error) => { process.stderr.write(`${error.message}\n`); stream.abort(); stopAll(); process.exit(1); });
  child.on("close", (code, signal) => {
    children.delete(child);
    if (buffer.trim()) write(buffer);
    // Let the last live events and the server shut down cleanly.
    setTimeout(() => { stream.abort(); stopAll(); process.exit(exiting ? 143 : signal ? 1 : code ?? 1); }, 150);
  });
}

async function main() {
  const options = parse(argv);
  if (!options) return plainRun();
  const password = randomUUID();
  // 1.x reads OPENCODE_SERVER_PASSWORD; 2.x reads OPENCODE_PASSWORD (and prefers it).
  const env = { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password };
  base = await startServer(env);
  if (!base || exiting) return plainRun();
  auth.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  if (await isOpenCode2()) return runV2(password);
  const directory = `?directory=${encodeURIComponent(options.dir)}`;
  abortSession = () => void api(`/session/${sessionId}/abort${directory}`, {}).catch(() => {});
  const stream = new AbortController();
  let prompted = false;
  // Only the assistant's words are ever shown live. The prompt is a text part
  // too, so every part waits until its message's role is known.
  const roles = new Map(), waiting = new Map();
  const forward = (event) => {
    const props = event.properties || {};
    if (event.type === "message.part.updated") {
      const part = props.part;
      if (part.type !== "tool") write({ type: "openbot.opencode_event", event: { type: event.type, properties: { part: { id: part.id, messageID: part.messageID, type: part.type, text: part.type === "text" ? part.text : undefined } } } });
      emitPart(part);
    } else write({ type: "openbot.opencode_event", event: { type: event.type, properties: { partID: props.partID, messageID: props.messageID, field: props.field, delta: props.delta } } });
  };
  const route = (event, messageId) => {
    const role = roles.get(messageId);
    if (role === "assistant") forward(event);
    else if (role === undefined) waiting.set(messageId, [...(waiting.get(messageId) || []), event].slice(-2_000));
  };
  const onEvent = (event) => {
    const props = event.properties || {};
    switch (event.type) {
      case "message.updated": {
        const info = props.info;
        if (!info?.id || info.sessionID !== sessionId) return;
        roles.set(info.id, info.role);
        const held = waiting.get(info.id) || [];
        waiting.delete(info.id);
        if (info.role === "assistant") for (const item of held) forward(item);
        return;
      }
      case "message.part.updated": {
        const part = props.part;
        if (part?.sessionID !== sessionId || earlier.has(part.messageID)) return;
        route(event, part.messageID);
        return;
      }
      case "message.part.delta":
        if ((props.sessionID && props.sessionID !== sessionId) || earlier.has(props.messageID)) return;
        route(event, props.messageID);
        return;
      case "permission.asked": case "permission.updated":
        // The server is private to this task, so every request here is ours.
        if (props.id) void api(`/permission/${props.id}/reply${directory}`, options.auto ? { reply: "once" } : { reply: "reject" }).catch(() => {});
        return;
      case "question.asked":
        if (props.id) void api(`/question/${props.id}/reject${directory}`, {}).catch(() => {});
        return;
      case "session.error":
        if (props.sessionID && props.sessionID !== sessionId) return;
        write({ type: "error", timestamp: Date.now(), sessionID: sessionId, error: props.error || { name: "UnknownError", data: { message: "OpenCode reported an error." } } });
        hadError = true;
        return;
      case "session.status":
        if (props.sessionID === sessionId && prompted && props.status?.type === "retry") quotaRetry(props.status);
        if (props.sessionID === sessionId && prompted && props.status?.type === "busy") sawWork = true;
        if (props.sessionID === sessionId && prompted && sawWork && props.status?.type === "idle") void done();
        return;
      case "session.idle":
        if (props.sessionID === sessionId && prompted && sawWork) void done();
        return;
      default:
    }
  };
  try {
    // Nothing has been sent yet, so an unfamiliar server (a newer OpenCode) just
    // means: run the plain way, which every version supports.
    try { await subscribe(stream.signal, onEvent); } catch { return fallBack(stream); }
    // If setting up fails, run the plain way too.
    try {
      if (options.session) {
        sessionId = options.session;
        for (const message of (await api(`/session/${sessionId}/message`, undefined, "GET")) || []) if (message.info?.id) earlier.add(message.info.id);
      }
      else sessionId = (await api(`/session${directory}`, { ...(options.title ? { title: options.title } : {}) })).id;
    } catch { return fallBack(stream); }
    const slash = options.model.indexOf("/");
    const parts = [
      { type: "text", text: options.prompt },
      ...options.files.map((file) => { const path = resolve(options.dir, file); return { type: "file", mime: mimeFor(path), filename: basename(path), url: `file://${path}` }; }),
    ];
    prompted = true; promptSent = true;
    try {
      await api(`/session/${sessionId}/prompt_async${directory}`, { model: { providerID: options.model.slice(0, slash), modelID: options.model.slice(slash + 1) }, ...(options.agent ? { agent: options.agent } : {}), parts });
    } catch (error) {
      // Refused outright: nothing ran, so the plain way is safe. A timeout may
      // mean it is already running, so keep watching rather than send twice.
      if (error instanceof Rejected) return fallBack(stream);
    }
    // A quick model can finish before the stream reports busy: poll status too.
    const poll = setInterval(async () => {
      try {
        const status = await api(`/session/status${directory}`, undefined, "GET");
        const mine = status?.[sessionId];
        if (mine?.type === "busy") sawWork = true;
        if (!mine || mine.type === "idle") {
          if (!sawWork) {
            const messages = await api(`/session/${sessionId}/message`, undefined, "GET");
            const last = (messages || []).filter((message) => message.info?.role === "assistant" && !earlier.has(message.info.id)).at(-1);
            if (last?.info?.time?.completed) sawWork = true;
          }
          if (sawWork) { clearInterval(poll); void done(); }
        }
      } catch { /* try again */ }
    }, 1_500);
    poll.unref?.();
  } catch (error) {
    failed(error instanceof Error ? error.message : String(error));
  }
}

void main();
