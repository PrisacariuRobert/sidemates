import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenBotDatabase } from "./testing/database.js";

const studio = () => {
  const root = mkdtempSync(path.join(tmpdir(), "side-thread-"));
  const db = new OpenBotDatabase(root, { dataDir: path.join(root, "data") });
  return db;
};

test("a message sent into a side thread is marked, and the main thread's own messages are not", () => {
  const db = studio();
  const root = db.addMessage({ threadId: "bot-nova", senderType: "bot", senderId: "nova", body: "Here is the plan." });
  const normal = db.addMessage({ threadId: "bot-nova", senderType: "user", senderId: null, body: "Thanks", replyToId: root.id });
  assert.equal(normal.sideRootId, null, "an ordinary reply stays in the main chat");
  const inThread = db.addMessage({ threadId: "bot-nova", senderType: "user", senderId: null, body: "What about step 2?", replyToId: root.id, sideRootId: root.id });
  assert.equal(inThread.sideRootId, root.id);
  assert.equal(db.getMessage(inThread.id)!.sideRootId, root.id, "it is stored");
  assert.equal(db.getMessage(root.id)!.sideRootId, null, "the original message is not itself hidden");
});

test("answers to a side-thread question stay in the thread, with or without a reply link", () => {
  const db = studio();
  const root = db.addMessage({ threadId: "bot-nova", senderType: "bot", senderId: "nova", body: "Here is the plan." });
  const question = db.addMessage({ threadId: "bot-nova", senderType: "user", senderId: null, body: "What about step 2?", replyToId: root.id, sideRootId: root.id });
  const run = db.createRun({ threadId: "bot-nova", botId: "nova", prompt: question.body, status: "queued", triggerMessageId: question.id });
  const linked = db.addMessage({ threadId: "bot-nova", senderType: "bot", senderId: "nova", body: "Step 2 is X.", runId: run.id, replyToId: question.id });
  assert.equal(linked.sideRootId, root.id, "a teammate reply follows its question");
  const status = db.addMessage({ threadId: "bot-nova", senderType: "system", senderId: null, body: "Stopped", runId: run.id, kind: "event", eventType: "run_stopped" });
  assert.equal(status.sideRootId, root.id, "a status line from the same run follows too");
  const unrelated = db.addMessage({ threadId: "bot-nova", senderType: "bot", senderId: "nova", body: "Separate note." });
  assert.equal(unrelated.sideRootId, null);
  const main = db.listMessages("bot-nova").filter((message) => !message.sideRootId).map((message) => message.id);
  assert.ok(main.includes(root.id) && main.includes(unrelated.id));
  assert.ok(!main.includes(question.id) && !main.includes(linked.id) && !main.includes(status.id));
});

test("only a plain message in the same conversation can start a side thread", () => {
  const db = studio();
  const root = db.addMessage({ threadId: "bot-nova", senderType: "bot", senderId: "nova", body: "Plan" });
  const other = db.addMessage({ threadId: "bot-pixel", senderType: "bot", senderId: "pixel", body: "Elsewhere" });
  const inThread = db.addMessage({ threadId: "bot-nova", senderType: "user", senderId: null, body: "Q", replyToId: root.id, sideRootId: root.id });
  const event = db.addMessage({ threadId: "bot-nova", senderType: "system", senderId: null, body: "note", kind: "event", eventType: "note" });
  const send = (sideRootId: string, threadId = "bot-nova") => db.addMessage({ threadId, senderType: "user", senderId: null, body: "x", sideRootId });
  assert.throws(() => send(other.id), /can no longer start a side thread/, "a message from another conversation");
  assert.throws(() => send(inThread.id), /can no longer start a side thread/, "threads do not nest");
  assert.throws(() => send(event.id), /can no longer start a side thread/, "status lines cannot be thread roots");
  assert.throws(() => send("00000000-0000-4000-8000-000000000000"), /can no longer start a side thread/, "unknown message");
});

test("a run started in a side thread keeps everything it writes in that thread, including helpers", () => {
  const db = studio();
  const root = db.addMessage({ threadId: "bot-nova", senderType: "bot", senderId: "nova", body: "Here is the plan." });
  const question = db.addMessage({ threadId: "bot-nova", senderType: "user", senderId: null, body: "Why?", replyToId: root.id, sideRootId: root.id });
  // The chat route starts runs with the thread recorded on the run, with no trigger message.
  const run = db.createRun({ threadId: "bot-nova", botId: "nova", prompt: question.body, status: "queued", sideRootId: root.id });
  assert.equal(db.getRun(run.id)!.sideRootId, root.id);
  const answer = db.addMessage({ threadId: "bot-nova", senderType: "bot", senderId: "nova", body: "Because.", runId: run.id });
  assert.equal(answer.sideRootId, root.id, "an answer with no reply link still stays in the thread");
  const stop = db.addMessage({ threadId: "bot-nova", senderType: "system", senderId: null, body: "Stopped", runId: run.id, kind: "event", eventType: "run_stopped" });
  assert.equal(stop.sideRootId, root.id, "so does its stop notice");
  const helper = db.createRun({ threadId: "bot-nova", botId: "pixel", prompt: "Help", status: "queued", parentRunId: run.id });
  assert.equal(db.getRun(helper.id)!.sideRootId, root.id, "help for a threaded run is threaded");
  const ordinary = db.createRun({ threadId: "bot-nova", botId: "nova", prompt: "Elsewhere", status: "queued" });
  assert.equal(db.getRun(ordinary.id)!.sideRootId, null, "other work is untouched");
  assert.equal(db.addMessage({ threadId: "bot-nova", senderType: "bot", senderId: "nova", body: "Normal.", runId: ordinary.id }).sideRootId, null);
});
