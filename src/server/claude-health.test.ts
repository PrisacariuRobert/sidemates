import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenBotDatabase } from "./testing/database.js";
import { OpenCodeRunner } from "./opencode.js";
import { AttachmentService } from "./attachments.js";
import { DEFAULT_EXECUTION_LIMITS } from "./execution-policy.js";
import { CLAUDE_REQUIRED_FLAGS, claudeHealth, claudeHealthMessage, inspectClaudeHelp, probeClaudeToolServer, resetClaudeHealthForTests } from "./claude-health.js";

const fullHelp = CLAUDE_REQUIRED_FLAGS.map((flag) => `  ${flag} <value>   something`).join("\n") + '\n (choices: "plan", "dontAsk")';

test("a Claude Code that still has every option Sidemates uses is healthy", () => {
  assert.deepEqual(inspectClaudeHelp(fullHelp), []);
});

test("a missing option is named in plain words, and a longer option does not stand in for it", () => {
  const without = fullHelp.replace("--tools <value>", "--tools-extra <value>");
  assert.deepEqual(inspectClaudeHelp(without), ["Claude Code no longer has the --tools option Sidemates relies on."]);
  assert.match(inspectClaudeHelp(fullHelp.replace("dontAsk", "ask"))[0], /permission mode/);
});

test("Sidemates' own tool server answers with the tools every Claude run needs", () => {
  assert.deepEqual(probeClaudeToolServer(), []);
});

test("the verdict is remembered per version and explains itself", () => {
  resetClaudeHealthForTests();
  let reads = 0;
  const read = () => { reads++; return fullHelp.replace("--resume", "--continue"); };
  const first = claudeHealth("9.0.0", read, () => []);
  const again = claudeHealth("9.0.0", read, () => []);
  assert.equal(first.ok, false);
  assert.equal(again, first);
  assert.equal(reads, 1);
  assert.match(claudeHealthMessage(first), /Claude Code 9\.0\.0 changed.*--resume.*pick another AI/);
  assert.equal(claudeHealth("9.0.1", () => fullHelp, () => []).ok, true);
});

test("a Claude job does not start when Claude Code has changed, and says why in plain words", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sidemates-claude-health-run-"));
  const db = new OpenBotDatabase(root);
  db.upsertProvider({ id: "local-claude", name: "Claude", provider: "claude", authMode: "subscription", runtime: "claude_code" });
  db.updateBot("nova", { providerInstanceId: "local-claude", model: "claude-code/sonnet", aiMode: "chosen" });
  let started = 0;
  const bad = { ok: false, version: "9.0.0", problems: ["Claude Code no longer has the --tools option Sidemates relies on."] };
  const runner = new OpenCodeRunner({ db, internalToken: "fixture", internalUrl: "http://127.0.0.1:1", onChange: () => {}, attachments: new AttachmentService(db), limits: DEFAULT_EXECUTION_LIMITS, claudeCheck: () => bad, spawnProcess: () => { started++; throw new Error("Claude must not start"); } });
  try {
    const trigger = db.addMessage({ threadId: "bot-nova", senderType: "user", senderId: null, body: "Hi" });
    const run = db.createRun({ threadId: "bot-nova", botId: "nova", prompt: "Hi", status: "queued", triggerMessageId: trigger.id });
    runner["executeRun"](db.getRun(run.id)!);
    for (let i = 0; i < 50 && ["queued", "running"].includes(db.getRun(run.id)!.status); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const done = db.getRun(run.id)!;
    assert.equal(done.status, "failed");
    assert.match(done.error || "", /Claude Code 9\.0\.0 changed.*--tools/);
    assert.equal(started, 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
