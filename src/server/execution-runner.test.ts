import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenBotDatabase } from "./testing/database.js";
import { OpenCodeRunner } from "./opencode.js";
import { AttachmentService } from "./attachments.js";
import {
  DEFAULT_EXECUTION_LIMITS,
  type ExecutionLimits,
} from "./execution-policy.js";

// Real OS processes, no model credentials or external requests. A child fixture
// can deliberately hang, ignore TERM, stream malformed output or report usage.
function assertNoFalseFinishedAnswer(db: OpenBotDatabase, run: { id: string; threadId: string }) {
  const messages = db.getState(run.threadId).messages.filter(message => message.runId === run.id);
  assert.equal(messages.some(message => message.senderType === "bot"), false, "A failed runtime must not publish a finished answer");
  assert.equal(messages.filter(message => message.senderType === "system" && message.eventType === "run_stopped").length, 1, "The host must report the failure once in the conversation");
}

function fixture(script: string, limits: Partial<ExecutionLimits> = {}, expectedWorkKind?: "morning" | "inbox", runtimeCheck?: () => { runtime: "opencode"; detectedVersion: string | null; compatibility: "verified" | "unsupported" | "unknown" }) {
  const root = mkdtempSync(path.join(tmpdir(), "openbot-execution-test-"));
  const db = new OpenBotDatabase(root);
  db.chooseInitialProvider("local-opencode", "opencode/muse-spark-1.2-contributor-free");
  let child: ChildProcess;
  const runner = new OpenCodeRunner({
    db,
    internalToken: "fixture",
    runtimeCheck: runtimeCheck || (() => ({ runtime: "opencode" as const, detectedVersion: "1.18.31", compatibility: "verified" as const })),
    internalUrl: "http://127.0.0.1:1",
    onChange: () => {},
    attachments: new AttachmentService(db),
    limits: { ...DEFAULT_EXECUTION_LIMITS, terminationGraceMs: 50, ...limits },
    spawnProcess: (_command, _args, options) => {
      child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        ...options,
        env: {},
      });
      return child;
    },
  });
  const run = db.createRun({
    threadId: "bot-nova",
    botId: "nova",
    prompt: "Fixture task",
    expectedWorkKind,
    status: "queued",
  });
  const start = async (runId = run.id) => {
    runner["executeRun"](db.getRun(runId)!);
    await once(child!, "close");
    await runner["finalizing"].get(runId);
    return db.getRun(runId)!;
  };
  const close = async () => {
    await runner.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { db, runner, run, start, close, child: () => child! };
}

test("an unconfigured teammate cannot spawn a runtime or silently choose a provider", async () => {
  const f = fixture('console.log("must not run")');
  try {
    f.db.updateBot("nova", { providerInstanceId: null, model: "" });
    f.runner["executeRun"](f.db.getRun(f.run.id)!);
    assert.equal(f.child(), undefined);
    assert.equal(f.db.getRun(f.run.id)?.status, "failed");
    assert.match(f.db.getRun(f.run.id)?.error || "", /Choose an AI provider/);
    assert.equal(f.db.getRun(f.run.id)?.inputTokens, 0);
  } finally { await f.close(); }
});

test("publishes the final turn only and persists earlier updates behind that result", async () => {
  const events = [
    { type: "text", part: { id: "part-one", messageID: "one", type: "text", text: "Checking the sample." } },
    { type: "tool_use", part: { type: "tool", tool: "workspace_read", state: { status: "completed" } } },
    { type: "text", part: { id: "part-two", messageID: "two", type: "text", text: "The sample is ready. Nothing was sent." } },
  ];
  const f = fixture(events.map(event => `console.log(${JSON.stringify(JSON.stringify(event))});`).join("\n"));
  try {
    const run = await f.start();
    assert.equal(run.status, "completed");
    assert.equal(run.summary, "The sample is ready. Nothing was sent.");
    const messages = f.db.getState(run.threadId).messages.filter(message => message.runId === run.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.body, run.summary);
    assert.deepEqual(messages[0]?.progressUpdates, ["Checking the sample."]);
    assert.deepEqual(f.db.getMessage(messages[0]!.id)?.progressUpdates, ["Checking the sample."]);
    assert.equal(f.db.listThreads().find(thread => thread.id === run.threadId)?.lastMessage, run.summary);
    const other = f.db.addMessage({ threadId: "bot-pixel", senderId: "pixel", senderType: "bot", runId: run.id, body: "Unrelated thread" });
    assert.deepEqual(other.progressUpdates, [], "Never expose another thread's progress through a mismatched run ID");
  } finally { await f.close(); }
});

test("a closed process remains owned until asynchronous answer finalization completes", async () => {
  const f = fixture('console.log(JSON.stringify({type:"text",text:"Final answer"}))');
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  f.runner["options"].attachments.resolveExistingArtifactLinks = async (_bot, _threadId, summary) => {
    await blocked;
    return summary;
  };
  try {
    f.runner["executeRun"](f.db.getRun(f.run.id)!);
    await once(f.child(), "close");
    assert.equal(f.db.getRun(f.run.id)?.status, "running");
    assert.equal(f.runner["running"].has(f.run.id), true, "the runner must retain ownership during finalization");
    release();
    await f.runner["finalizing"].get(f.run.id);
    assert.equal(f.db.getRun(f.run.id)?.status, "completed");
    assert.equal(f.runner["running"].has(f.run.id), false);
  } finally { release(); await f.close(); }
});

test("a rejected answer resolver fails recoverably, releases ownership, and does not block shutdown", async () => {
  const f = fixture('console.log(JSON.stringify({type:"text",text:"Recoverable final text"}))');
  f.runner["options"].attachments.resolveExistingArtifactLinks = async () => {
    throw new Error("fixture resolver failed");
  };
  try {
    const result = await f.start();
    assert.equal(result.status, "failed");
    assert.match(result.error || "", /Could not finalize.*fixture resolver failed/);
    assert.equal(result.partialText, "Recoverable final text");
    assert.equal(f.runner["running"].has(result.id), false);
    assert.equal(f.runner["processControls"].has(result.id), false);
    assert.equal(f.runner["finalizing"].has(result.id), false);
    await f.runner.stop();
  } finally { await f.close(); }
});

test("exit zero after a tool or explicit runtime error cannot post a false finished answer", async () => {
  for (const last of [{ type: "tool_use" }, { type: "error", error: { message: "Fixture error" } }]) {
    const f = fixture(`console.log(JSON.stringify({type:"text",text:"Starting work."}));console.log(${JSON.stringify(JSON.stringify(last))});`);
    try {
      const run = await f.start();
      assert.equal(run.status, "failed");
      assert.equal(run.partialText, "Starting work.");
      assertNoFalseFinishedAnswer(f.db, run);
    } finally { await f.close(); }
  }
});

test("a clean exit after a completed read gets one same-task continuation, retaining usage and avoiding premature delivery", async () => {
  const f = fixture(`import fs from 'node:fs';
const marker='.continued-once';
console.log(JSON.stringify({type:'step_finish',sessionID:'continuation-session',part:{id:fs.existsSync(marker)?'second':'first',tokens:{input:100,output:20}}}));
if (!fs.existsSync(marker)) {fs.writeFileSync(marker,'yes');console.log(JSON.stringify({type:'tool_use',part:{type:'tool',tool:'workspace_read',state:{status:'completed'}}}));}
else console.log(JSON.stringify({type:'text',text:'Checked the saved result. Nothing was repeated.'}));`);
  try {
    const first = await f.start();
    assert.equal(first.status, 'queued');
    assert.equal(first.completionRepairCount, 1);
    assert.equal(first.inputTokens, 100);
    assert.equal(f.db.getState(first.threadId).messages.some(message => message.runId === first.id), false);
    const second = await f.start();
    assert.equal(second.id, first.id);
    assert.equal(second.status, 'completed');
    assert.equal(second.inputTokens, 200);
    assert.equal(second.completionRepairCount, 1);
    assert.match(second.summary!, /Nothing was repeated/);
  } finally { await f.close(); }
});

test("intermediate continuation cannot loop or turn an unconfirmed write into an automatic retry", async () => {
  const f = fixture(`console.log(JSON.stringify({type:'tool_use',part:{type:'tool',tool:'task_plan',state:{status:'completed'}}}));`);
  try {
    assert.equal((await f.start()).status, 'queued');
    const second = await f.start();
    assert.equal(second.status, 'failed');
    assert.equal(second.completionRepairCount, 1);
    assertNoFalseFinishedAnswer(f.db, second);
  } finally { await f.close(); }
  const write = fixture(`console.log(JSON.stringify({type:'tool_use',part:{type:'tool',tool:'browser_click',state:{status:'completed'}}}));`);
  try {
    const result = await write.start();
    assert.equal(result.status, 'failed');
    assert.equal(result.completionRepairCount, 0);
  } finally { await write.close(); }
});

test(
  "stalled worker is force-stopped, preserving prior progress and its real failure reason",
  { timeout: 5000 },
  async () => {
    const f = fixture(
      'process.on("SIGTERM", () => {}); console.log(JSON.stringify({type:"text",text:"Partial work"})); setInterval(()=>{},1000)',
      // Allow process startup under concurrent CI load, then exercise the idle
      // kill path. A 100 ms total window can expire before Node prints at all.
      { maxIdleMs: 500 },
    );
    try {
      const run = await f.start();
      assert.equal(run.status, "failed");
      assert.match(run.error || "", /stopped making progress/);
      assert.equal(run.partialText, "Partial work");
      assert.equal(f.child().signalCode, "SIGKILL");
      assert.ok(run.activeDurationMs >= 100);
      assertNoFalseFinishedAnswer(f.db, run);
    } finally {
      await f.close();
    }
  },
);

test(
  "weekly usage is persisted before process exit and is not counted twice",
  { timeout: 5000 },
  async () => {
    const event = {
      type: "step_finish",
      part: { id: "one", tokens: { input: 40, output: 10 }, cost: 0.02 },
    };
    const f = fixture(
      `console.log(${JSON.stringify(JSON.stringify(event))});setTimeout(()=>console.log(JSON.stringify({type:"text",text:"done"})),500);`,
    );
    try {
      f.db.updateRun(f.run.id, {
        inputTokens: 7,
        outputTokens: 3,
        modelSteps: 2,
        activeDurationMs: 50,
      });
      const done = f.start();
      await once(f.child().stdout!, "data");
      assert.equal(f.db.getRun(f.run.id)?.inputTokens, 47);
      assert.equal(f.db.getBot("nova")?.tokensUsedThisWeek, 60);
      const result = await done;
      assert.equal(result.status, "completed");
      assert.equal(result.inputTokens, 47);
      assert.equal(result.outputTokens, 13);
      assert.equal(result.cost, 0.02);
      assert.equal(result.modelSteps, 3);
    } finally {
      await f.close();
    }
  },
);

test(
  "a step reserve blocks dispatch before unreserved usage lands",
  { timeout: 5000 },
  async () => {
    const f = fixture('console.log("must not spawn")');
    try {
      f.db.updateBot("nova", { weeklyTokenBudget: 100 });
      f.runner["leader"] = true;
      await f.runner["tick"]();
      assert.equal(f.child(), undefined, "No model process may start without a reserved step");
      const run = f.db.getRun(f.run.id)!;
      assert.equal(run.status, "failed");
      assert.match(run.error || "", /less than one bounded model step/);
      assert.equal(run.inputTokens, 0, "Nothing was accounted because nothing was dispatched");
      assert.equal(f.db.getBot("nova")?.tokensUsedThisWeek, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "a reported weekly budget overrun stops without posting a false success",
  { timeout: 5000 },
  async () => {
    const f = fixture(
      'console.log(JSON.stringify({type:"step_finish",part:{id:"a",tokens:{input:7000,output:5}}}));setInterval(()=>{},1000)',
    );
    try {
      f.db.updateBot("nova", { weeklyTokenBudget: 20000 });
      f.db.updateRun(f.run.id, { inputTokens: 14000 });
      const result = await f.start();
      assert.equal(result.status, "failed");
      assert.match(result.error || "", /weekly token limit/);
      assert.equal(result.inputTokens, 21000);
      assert.equal(f.db.getBot("nova")?.tokensUsedThisWeek, 21005);
      assertNoFalseFinishedAnswer(f.db, result);
    } finally {
      await f.close();
    }
  },
);

test(
  "output without newlines is bounded and plain runtime logs are not published as answers",
  { timeout: 5000 },
  async () => {
    const flood = fixture(
      'process.stdout.write("x".repeat(5000));setInterval(()=>{},1000)',
      { maxOutputBytes: 1000 },
    );
    try {
      assert.match((await flood.start()).error || "", /too much output/);
    } finally {
      await flood.close();
    }
    const log = fixture(
      'console.log("Provider disconnected: reconnect needed")',
    );
    try {
      const result = await log.start();
      assert.equal(result.status, "failed");
      assertNoFalseFinishedAnswer(log.db, result);
    } finally {
      await log.close();
    }
  },
);

test("a stopped run cannot reset its persisted step allowance by resuming", async () => {
  const f = fixture('throw new Error("must not spawn")', { maxSteps: 2 });
  try {
    f.db.updateRun(f.run.id, { modelSteps: 2 });
    f.runner["executeRun"](f.db.getRun(f.run.id)!);
    assert.equal(f.db.getRun(f.run.id)?.status, "failed");
    assert.match(f.db.getRun(f.run.id)?.error || "", /step limit/);
    assert.equal(f.child(), undefined);
  } finally {
    await f.close();
  }
});

test(
  "active-time limit stops even a worker that keeps emitting progress",
  { timeout: 5000 },
  async () => {
    const f = fixture(
      'setInterval(()=>console.log(JSON.stringify({type:"text",text:"still working "})),20)',
      { maxActiveMs: 150, maxIdleMs: 500 },
    );
    try {
      assert.match((await f.start()).error || "", /time limit/);
    } finally {
      await f.close();
    }
  },
);

test(
  "per-task token limits stop a worker below its larger weekly allowance",
  { timeout: 5000 },
  async () => {
    const f = fixture(
      'console.log(JSON.stringify({type:"step_finish",part:{id:"a",tokens:{input:55,output:5}}}));setInterval(()=>{},1000)',
      { maxTokens: 50 },
    );
    try {
      const result = await f.start();
      assert.equal(result.status, "awaiting_approval");
      assert.equal(f.db.getApproval(result.approvalId!)?.kind, "budget");
      assert.equal(result.inputTokens, 55);
      const reopened = new OpenBotDatabase(f.db.rootDir);
      try {
        assert.equal(reopened.getRun(result.id)?.modelSteps, 1);
        assert.equal(reopened.getRun(result.id)?.inputTokens, 55);
        assert.equal(
          reopened.getRun(result.id)?.activeDurationMs,
          result.activeDurationMs,
        );
      } finally {
        reopened.close();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "stopping a coordinator also cancels nested work and pending approvals",
  { timeout: 5000 },
  async () => {
    const f = fixture(
      'process.on("SIGTERM",()=>{});console.log(JSON.stringify({type:"text",text:"Starting"}));setInterval(()=>{},1000)',
    );
    try {
      const done = f.start();
      await once(f.child().stdout!, "data");
      const child = f.db.createRun({
        threadId: f.run.threadId,
        botId: "pixel",
        parentRunId: f.run.id,
        prompt: "Consult",
        status: "queued",
      });
      const nested = f.db.createRun({
        threadId: f.run.threadId,
        botId: "scout",
        parentRunId: child.id,
        prompt: "Check",
        status: "running",
      });
      f.db.createApproval({
        runId: nested.id,
        botId: "scout",
        kind: "external",
        reason: "Review",
        actionLabel: "Fixture",
        action: {},
      });
      assert.equal(f.runner.cancelTask(f.run.id), true);
      const result = await done;
      assert.equal(result.status, "cancelled");
      assert.equal(f.db.getRun(child.id)?.status, "cancelled");
      assert.equal(f.db.getRun(nested.id)?.status, "cancelled");
      assert.equal(f.db.listApprovals().length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "stopping for an approval preserves the decision and recorded usage",
  { timeout: 5000 },
  async () => {
    const f = fixture(
      'process.on("SIGTERM",()=>{});console.log(JSON.stringify({type:"step_finish",part:{id:"a",tokens:{input:10,output:2}}}));setInterval(()=>{},1000)',
    );
    try {
      const done = f.start();
      await once(f.child().stdout!, "data");
      const approval = f.db.createApproval({
        runId: f.run.id,
        botId: "nova",
        kind: "external",
        reason: "Review email",
        actionLabel: "Send fixture",
        action: {},
      });
      f.runner.cancel(f.run.id);
      const result = await done;
      assert.equal(result.status, "awaiting_approval");
      assert.equal(result.inputTokens, 10);
      assert.equal(f.db.listApprovals()[0]?.id, approval.id);
      assert.equal(f.db.listApprovals()[0]?.status, "pending");
    } finally {
      await f.close();
    }
  },
);

for (const nextStatus of ["queued", "running", "cancelled"] as const) {
  test(`approval shutdown preserves a fast ${nextStatus} decision`, { timeout: 5000 }, async () => {
    const f = fixture('console.log(JSON.stringify({type:"step_finish",part:{id:"a",tokens:{input:10,output:2}}}));setInterval(()=>{},1000)');
    try {
      const done = f.start();
      await once(f.child().stdout!, "data");
      f.db.createApproval({ runId: f.run.id, botId: "nova", kind: "external", reason: "Review", actionLabel: "Send fixture", action: {} });
      f.runner.pauseForApproval(f.run.id);
      assert.equal(f.runner.isApprovalPaused(f.run.id), true, "The retiring worker loses tool access immediately");
      f.db.updateRun(f.run.id, { status: nextStatus });
      const result = await done;
      assert.equal(result.status, nextStatus, "An old child's SIGTERM must not cancel a queued continuation or approved action in flight");
      assert.equal(result.inputTokens, 10);
      assert.equal(f.runner.isApprovalPaused(f.run.id), false);
    } finally { await f.close(); }
  });
}

test(
  "shutdown waits for an uncooperative worker before requeuing its saved work",
  { timeout: 5000 },
  async () => {
    const f = fixture(
      'process.on("SIGTERM",()=>{});console.log(JSON.stringify({type:"text",text:"Saved partial answer"}));console.log(JSON.stringify({type:"step_finish",part:{id:"a",tokens:{input:10,output:2}}}));setInterval(()=>{},1000)',
    );
    try {
      f.db.claimNextQueuedRun([], f.runner.instanceId);
      const done = f.start();
      await once(f.child().stdout!, "data");
      const stopped = f.runner.stop();
      assert.equal(f.db.getRun(f.run.id)?.status, "running");
      await stopped;
      await done;
      const resumed = f.db.getRun(f.run.id)!;
      assert.equal(f.child().signalCode, "SIGKILL");
      assert.equal(resumed.status, "queued");
      assert.equal(resumed.partialText, "Saved partial answer");
      assert.equal(resumed.inputTokens, 10);
      assert.equal(resumed.modelSteps, 1);
    } finally {
      await f.close();
    }
  },
);

test("a shared job cap stops running, queued, and approval-waiting consultants without affecting other jobs", { timeout: 5000 }, async () => {
  const f = fixture('console.log(JSON.stringify({type:"step_finish",part:{id:"a",tokens:{input:35,output:5}}}));setInterval(()=>{},1000)', { maxJobTokens: 70 });
  try {
    const finished = f.db.createRun({ threadId: f.run.threadId, botId: "pixel", parentRunId: f.run.id, prompt: "Finished consultation", status: "completed" });
    f.db.updateRun(finished.id, { inputTokens: 30, outputTokens: 5 });
    const pending = f.db.createRun({ threadId: f.run.threadId, botId: "pixel", parentRunId: f.run.id, prompt: "Waiting consultation", status: "queued" });
    const nested = f.db.createRun({ threadId: f.run.threadId, botId: "scout", parentRunId: pending.id, prompt: "Draft action", status: "queued" });
    const approval = f.db.createApproval({ runId: nested.id, botId: "scout", kind: "external", reason: "Review", actionLabel: "Send", action: {} });
    const other = f.db.createRun({ threadId: f.run.threadId, botId: "scout", prompt: "Unrelated task", status: "queued" });
    const result = await f.start();
    assert.equal(result.status, "awaiting_approval");
    assert.equal(f.db.getApproval(result.approvalId!)?.kind, "budget");
    assert.equal(f.db.getRun(pending.id)?.status, "awaiting_approval");
    assert.equal(f.db.getRun(nested.id)?.status, "awaiting_approval");
    assert.equal(f.db.getRun(finished.id)?.status, "completed");
    assert.ok(!f.db.listApprovals().some((item) => item.id === approval.id));
    assert.equal(f.db.getRun(other.id)?.status, "queued");
    assert.equal(f.db.getJobUsage(result.id).totalTokens, 75);
    assert.equal(f.db.listMessages(result.threadId).filter(message => message.runId === result.id && message.senderType === 'bot').length, 0);
  } finally { await f.close(); }
});

test("steering and a database restart cannot reset the shared job allowance", async () => {
  const f = fixture('throw new Error("must not spawn")', { maxJobTokens: 50 });
  try {
    f.db.updateRun(f.run.id, { inputTokens: 20, status: "cancelled" });
    const consultant = f.db.createRun({ threadId: f.run.threadId, botId: "pixel", parentRunId: f.run.id, prompt: "Consultation", status: "failed" });
    f.db.updateRun(consultant.id, { inputTokens: 25, reasoningTokens: 5 });
    const next = f.db.createRun({ threadId: f.run.threadId, botId: "nova", steeredFromRunId: f.run.id, prompt: "Continue the task", status: "queued" });
    const reopened = new OpenBotDatabase(f.db.rootDir);
    try {
      assert.equal(reopened.getJobUsage(next.id).totalTokens, 50);
      assert.equal(reopened.getJobUsage(next.id).rootRunId, f.run.id);
    } finally { reopened.close(); }
    f.runner["executeRun"](next);
    assert.equal(f.child(), undefined, "No model process may start once the family is over budget");
    assert.equal(f.db.getRun(next.id)?.status, "awaiting_approval");
    assert.equal(f.db.getRun(f.run.id)?.status, "cancelled", "Do not resurrect the historical root");
    assert.equal(f.db.getApproval(f.db.getRun(next.id)!.approvalId!)?.kind, "budget");
  } finally { await f.close(); }
});

test("a consultant's recorded usage stops its running coordinator without stopping unrelated work", { timeout: 5000 }, async () => {
  const f = fixture('console.log(JSON.stringify({type:"text",text:"Working"}));setInterval(()=>{},1000)', { maxJobTokens: 50 });
  try {
    const root = f.db.createRun({ threadId: f.run.threadId, botId: "pixel", prompt: "Coordinate", status: "waiting_for_teammate" });
    const sibling = f.db.createRun({ threadId: f.run.threadId, botId: "scout", parentRunId: f.run.id, prompt: "Another part", status: "queued" });
    const done = f.start();
    await once(f.child().stdout!, "data");
    f.db.updateRun(sibling.id, { inputTokens: 50 });
    assert.equal(f.runner["enforceJobBudget"](sibling.id), true);
    const result = await done;
    assert.equal(result.status, "awaiting_approval");
    assert.equal(f.db.getRun(sibling.id)?.status, "awaiting_approval");
    assert.equal(f.db.getRun(root.id)?.status, "waiting_for_teammate", "Unrelated coordinator is unaffected");
  } finally { await f.close(); }
});

test("parallel consultants share one budget and cannot resume their waiting coordinator after reaching it", { timeout: 5000 }, async () => {
  const f = fixture('setTimeout(()=>console.log(JSON.stringify({type:"step_finish",part:{id:"a",tokens:{input:25,output:5}}})),30);setInterval(()=>{},1000)', { maxJobTokens: 50 });
  try {
    f.db.markRunConsultationPending(f.run.id);
    f.db.pauseRunForConsultation(f.run.id);
    const first = f.db.createRun({ threadId: f.run.threadId, botId: "pixel", parentRunId: f.run.id, prompt: "First part", status: "queued" });
    const second = f.db.createRun({ threadId: f.run.threadId, botId: "scout", parentRunId: f.run.id, prompt: "Second part", status: "queued" });
    const results = await Promise.all([f.start(first.id), f.start(second.id)]);
    assert.deepEqual(results.map((run) => run.status), ["awaiting_approval", "awaiting_approval"]);
    assert.equal(f.db.getJobUsage(f.run.id).totalTokens, 60);
    assert.equal(f.db.getRun(f.run.id)?.status, "awaiting_approval");
    assert.equal(f.runner["resumeCoordinatorIfReady"](f.run.id), false);
    assert.equal(f.db.listRuns(f.run.threadId).filter((run) => run.status === "running").length, 0);
  } finally { await f.close(); }
});

test("a promised report is repaired once, then fails honestly without publishing a false completion", async () => {
  const f = fixture('console.log(JSON.stringify({type:"text",text:"Done, your report is ready"}));console.log(JSON.stringify({type:"step_finish",part:{id:"a",tokens:{input:10,output:2}}}))', {}, "morning");
  try {
    const first = await f.start();
    assert.equal(first.status, "queued");
    assert.equal(first.completionRepairCount, 1);
    assert.equal(first.inputTokens, 10);
    const reopened = new OpenBotDatabase(f.db.rootDir);
    try {
      assert.equal(reopened.getRun(first.id)?.expectedWorkKind, "morning");
      assert.equal(reopened.getRun(first.id)?.completionRepairCount, 1);
    } finally { reopened.close(); }
    const second = await f.start();
    assert.equal(second.status, "failed");
    assert.match(second.error || "", /did not save/);
    assert.equal(second.inputTokens, 20);
    assertNoFalseFinishedAnswer(f.db, second);
    const steered = f.db.createRun({ botId: "nova", threadId: second.threadId, prompt: "Continue", status: "queued", steeredFromRunId: second.id });
    assert.equal(steered.expectedWorkKind, "morning");
    assert.equal(steered.completionRepairCount, 1);
  } finally { await f.close(); }
});

test("only a matching saved report satisfies a starter's completion contract", async () => {
  const f = fixture('console.log(JSON.stringify({type:"text",text:"Your report is ready"}))', {}, "morning");
  const save = (id: string, kind: "morning" | "inbox") => {
    f.db.saveWorkSnapshot({ id, runId: f.run.id, botId: "nova", accountEmail: "fixture@example.test", kind, fetchedAt: new Date().toISOString(), timeZone: "UTC", window: { from: new Date().toISOString(), until: new Date().toISOString(), mailQuery: "in:inbox" }, sources: [], coverage: [{ service: "gmail", state: "complete", count: 0, detail: "Fixture inbox was checked." }] });
    f.db.saveWorkReport({ snapshotId: id, savedAt: new Date().toISOString(), items: [], drafts: [], markdown: "# Empty fixture inbox" });
  };
  try {
    save("wrong-kind", "inbox");
    assert.equal((await f.start()).status, "queued");
    save("matching-kind", "morning");
    const finished = await f.start();
    assert.equal(finished.status, "completed");
    assert.equal(f.db.getState(finished.threadId).messages.filter((message) => message.runId === finished.id).length, 1);
  } finally { await f.close(); }
});

test("an unverified runtime never spawns the model process", async () => {
  const f = fixture('console.log("must not run")', {}, undefined, () => ({ runtime: "opencode", detectedVersion: "1.19.0", compatibility: "unsupported" }));
  try {
    f.runner["executeRun"](f.db.getRun(f.run.id)!);
    assert.equal(f.child(), undefined, "no process may spawn under an unsupported runtime");
    assert.equal(f.db.getRun(f.run.id)?.status, "failed");
    assert.match(f.db.getRun(f.run.id)?.error || "", /runtime not verified/i);
  } finally { await f.close(); }
});

test("an unknown runtime version also fails closed before spawning", async () => {
  const f = fixture('console.log("must not run")', {}, undefined, () => ({ runtime: "opencode", detectedVersion: null, compatibility: "unknown" }));
  try {
    f.runner["executeRun"](f.db.getRun(f.run.id)!);
    assert.equal(f.child(), undefined);
    assert.equal(f.db.getRun(f.run.id)?.status, "failed");
    assert.match(f.db.getRun(f.run.id)?.error || "", /could not check the installed OpenCode version/i);
    assert.match(f.db.getRun(f.run.id)?.error || "", /No model was started/i);
  } finally { await f.close(); }
});

test("an armed tester fault stops the run through the normal failure path", { timeout: 5000 }, async () => {
  const f = fixture('console.log(JSON.stringify({type:"text",text:"working"}));setInterval(()=>{},1000)');
  try {
    const done = f.start();
    await once(f.child().stdout!, "data");
    f.runner.injectFaultStop(f.run.id);
    const result = await done;
    assert.equal(result.status, "failed");
    assert.match(result.error || "", /tester_fault/);
    assertNoFalseFinishedAnswer(f.db, result);
  } finally { await f.close(); }
});

test("at the step limit a task gets one tool-free turn to answer, then stops honestly", { timeout: 10000 }, async () => {
  const stepping = 'let i = 0; setInterval(() => { i++; console.log(JSON.stringify({ type: "step_finish", part: { id: "s" + i } })); }, 2);';
  const f = fixture(stepping, { maxSteps: 3 });
  try {
    const first = await f.start();
    assert.equal(first.status, "queued", "requeued for a final answer instead of failing");
    assert.match(first.prompt, /Do not use any more tools/);
    assert.ok(first.activities.some((activity) => activity.label === "Wrapping up with what it found"));
    const stepsAtStop = first.modelSteps;
    const second = await f.start();
    assert.equal(second.status, "failed", "a wrap-up that keeps working still stops");
    assert.match(second.error || "", /step limit/);
    assert.ok(second.modelSteps > stepsAtStop, "the answer turn actually ran");
    assert.ok(second.modelSteps <= stepsAtStop + 6 + 30, `bounded wrap-up (shutdown grace included) (${stepsAtStop} → ${second.modelSteps} steps)`);
  } finally { await f.close(); }
});

test("a tool call written out as text fails the job instead of reading as done", async () => {
  const events = [
    { type: "text", part: { id: "part-one", messageID: "one", type: "text", text: "All done! <｜DSML｜tool_calls><｜DSML｜invoke name=\"openbot_workspace_write\">notes.txt</｜DSML｜invoke></｜DSML｜tool_calls>" } },
  ];
  const f = fixture(events.map(event => `console.log(${JSON.stringify(JSON.stringify(event))});`).join("\n"));
  try {
    const run = await f.start();
    assert.equal(run.status, "failed");
    assert.match(run.error || "", /wrote out a tool call instead of using it/);
    assertNoFalseFinishedAnswer(f.db, run);
  } finally {
    await f.close();
  }
});
