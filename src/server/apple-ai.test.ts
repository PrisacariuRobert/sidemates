import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { OpenBotDatabase } from "./testing/database.js";
import { OpenCodeRunner } from "./opencode.js";
import { AttachmentService } from "./attachments.js";
import { DEFAULT_EXECUTION_LIMITS } from "./execution-policy.js";
import { appleAiHelper, appleAiStatus, appleInstructions, applePrompt, respondOnApple } from "./apple-ai.js";
import type { Message } from "../shared/types.js";

test("the Apple helper is found next to Sidemates or on the app's PATH", () => {
  const has = (files: string[]) => (file: string) => files.includes(file);
  assert.equal(appleAiHelper({ PATH: "/app/bin:/usr/bin" }, has(["/app/bin/apple-ai"])), "/app/bin/apple-ai");
  assert.equal(appleAiHelper({ OPENBOT_APPLE_AI: "/custom/apple-ai", PATH: "/app/bin" }, has(["/custom/apple-ai", "/app/bin/apple-ai"])), "/custom/apple-ai");
  assert.equal(appleAiHelper({ PATH: "/usr/bin" }, has([])), null);
});

test("status and answers come back in plain words", async () => {
  assert.deepEqual(await appleAiStatus("linux", "/app/bin/apple-ai", async () => "{}"), { installed: false, available: false, reason: "Apple's built-in AI needs a Mac with Apple Intelligence." });
  assert.deepEqual(await appleAiStatus("darwin", "/app/bin/apple-ai", async () => JSON.stringify({ available: false, reason: "Apple Intelligence is turned off." })), { installed: true, available: false, reason: "Apple Intelligence is turned off." });
  assert.equal((await appleAiStatus("darwin", "/app/bin/apple-ai", async () => JSON.stringify({ available: true }))).available, true);
  assert.equal((await appleAiStatus("darwin", "/app/bin/apple-ai", async () => { throw new Error("crashed"); })).available, false);
  let sent = "";
  assert.equal(await respondOnApple({ instructions: "Be brief.", prompt: "Hi" }, "/app/bin/apple-ai", async (_helper, input) => { sent = input; return JSON.stringify({ text: " Hello! " }); }), "Hello!");
  assert.deepEqual(JSON.parse(sent), { mode: "respond", instructions: "Be brief.", prompt: "Hi" });
  await assert.rejects(respondOnApple({ instructions: "", prompt: "x" }, "/app/bin/apple-ai", async () => JSON.stringify({ error: "too long", code: "too_long" })), /too long for Apple's built-in AI/);
  await assert.rejects(respondOnApple({ instructions: "", prompt: "x" }, null), /isn't set up/);
});

test("Apple's model hears who it is and what it can't do, with a little recent conversation", () => {
  const instructions = appleInstructions({ name: "Nova", role: "Keeps your inbox under control", instructions: "Keeps your inbox under control" });
  assert.match(instructions, /^You are Nova, a persistent Sidemates teammate/);
  assert.match(instructions, /without tools/);
  assert.match(instructions, /Never claim you did something/);
  assert.doesNotMatch(instructions, /Owner's notes/, "A job repeated as notes isn't sent twice");
  const message = (senderType: Message["senderType"], body: string, senderName = "Nova") => ({ senderType, senderName, body, kind: "text" as const });
  const prompt = applePrompt([message("user", "Hi Nova"), message("bot", "Hi! What's up?"), { ...message("system", "joined"), kind: "event" as const }, message("user", "Write a two-line thank-you to Ana")], "Write a two-line thank-you to Ana");
  assert.equal(prompt, "Recent conversation:\nOwner: Hi Nova\nNova: Hi! What's up?\n\nThe owner asks: Write a two-line thank-you to Ana");
});

function fixture(respond: (input: { instructions: string; prompt: string }) => Promise<string>) {
  const root = mkdtempSync(path.join(tmpdir(), "sidemates-apple-"));
  const db = new OpenBotDatabase(root);
  db.upsertProvider({ id: "local-apple", name: "Apple Intelligence", provider: "apple", authMode: "subscription", runtime: "apple_fm" });
  db.updateBot("nova", { providerInstanceId: "local-apple", model: "apple/on-device", aiMode: "chosen" });
  let spawned = 0;
  const runner = new OpenCodeRunner({ db, internalToken: "fixture", internalUrl: "http://127.0.0.1:1", onChange: () => {}, attachments: new AttachmentService(db), limits: DEFAULT_EXECUTION_LIMITS, appleRespond: respond, spawnProcess: () => { spawned++; throw new Error("No other AI program may start"); } });
  const trigger = db.addMessage({ threadId: "bot-nova", senderType: "user", senderId: null, body: "Write a two-line thank-you to Ana" });
  const run = db.createRun({ threadId: "bot-nova", botId: "nova", prompt: trigger.body, status: "queued", triggerMessageId: trigger.id });
  const finished = async () => { runner["executeRun"](db.getRun(run.id)!); for (let i = 0; i < 50 && ["queued", "running"].includes(db.getRun(run.id)!.status); i++) await new Promise((resolve) => setTimeout(resolve, 20)); return db.getRun(run.id)!; };
  return { db, run, finished, spawned: () => spawned, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("a teammate on Apple's AI answers from this Mac, without starting another AI program", async () => {
  let asked: { instructions: string; prompt: string } | null = null;
  const f = fixture(async (input) => { asked = input; return "Thank you, Ana! Your help this week made all the difference."; });
  try {
    const done = await f.finished();
    assert.equal(done.status, "completed");
    assert.equal(f.spawned(), 0);
    assert.match(asked!.instructions, /You are Nova/);
    assert.match(asked!.prompt, /The owner asks: Write a two-line thank-you to Ana$/);
    assert.equal(f.db.listMessages("bot-nova").at(-1)?.body, "Thank you, Ana! Your help this week made all the difference.");
    assert.ok(done.activities.some((activity) => activity.detail === "Using Apple Intelligence on this Mac"));
  } finally { f.close(); }
});

test("when Apple's AI can't answer, the job stops with the reason and a stop note", async () => {
  const f = fixture(async () => { throw new Error("This is too long for Apple's built-in AI. Connect ChatGPT, Claude or Gemini for bigger jobs."); });
  try {
    const done = await f.finished();
    assert.equal(done.status, "failed");
    assert.match(done.error || "", /too long for Apple's built-in AI/);
    assert.ok(f.db.listMessages("bot-nova").some((message) => message.eventType === "run_stopped"));
  } finally { f.close(); }
});
