import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { OpenBotDatabase } from "./testing/database.js";
import { buildReadinessSteps } from "./readiness.js";
import type { Readiness } from "../shared/types.js";

test("readiness reports the three setup steps and tracks teammates", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "openbot-readiness-")), db = new OpenBotDatabase(root);
  const botIds = db.listBots().map((bot) => bot.id);
  assert.ok(botIds.length > 0);
  // This checks teammates whose AI the owner chose. Teammates on Automatic are
  // ready as soon as any AI is connected, which depends on the host.
  for (const id of botIds) db.updateBot(id, { aiMode: "chosen" });
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const base = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, OPENBOT_LOAD_ENV: "0", OPENBOT_DATA_DIR: db.dataDir, OPENBOT_PORT: String(address.port), OPENBOT_APP_URL: base, OPENBOT_HOST: "127.0.0.1", OPENBOT_DEPLOYMENT_MODE: "local", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit"); let log = "";
  child.stdout.on("data", (chunk) => { log = (log + chunk).slice(-3_000); });
  child.stderr.on("data", (chunk) => { log = (log + chunk).slice(-3_000); });
  const readiness = async () => await (await fetch(`${base}/api/readiness`)).json() as Readiness;
  try {
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(base + "/api/healthz", { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Startup. */ }
      if (child.exitCode !== null) throw new Error(`Fixture host exited (${child.exitCode}): ${log}`);
      if (attempt >= 200) throw new Error(log || "Fixture host did not start within the bounded startup window.");
      await delay(100);
    }
    const initial = await readiness();
    assert.deepEqual(initial.steps.map((step) => step.id), ["runtime", "connection", "teammate"]);
    for (const step of initial.steps) {
      assert.equal(typeof step.ready, "boolean");
      assert.ok(step.label.length > 0);
      assert.ok(step.detail.length > 0);
    }
    assert.equal(initial.steps.find((step) => step.id === "teammate")?.ready, false, "saved teammates without a provider assignment are not ready");
    assert.equal(initial.ready, initial.steps.every((step) => step.ready), "overall stays the conjunction of steps");
    db.updateBot("nova", { providerInstanceId: "local-opencode", model: "opencode/fixture" });
    assert.equal((await readiness()).steps.find((step) => step.id === "teammate")?.ready, true);
    for (const id of botIds) db.retireBot(id);
    assert.equal((await readiness()).steps.find((step) => step.id === "teammate")?.ready, false);
    db.updateStudioSettings({ maxTeammates: 100 });
    for (const id of botIds) db.restoreBot(id);
    assert.equal((await readiness()).steps.find((step) => step.id === "teammate")?.ready, true, "restoring keeps the working assignment");
  } finally {
    child.kill("SIGTERM"); await Promise.race([exited, delay(4_000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await exited; }
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("readiness steps tell saved apart from runnable", () => {
  const base = { cliAvailable: true, compatibility: "verified" as const, detectedVersion: "1.18.31", connectedNames: ["My OpenCode"], readyTeammates: 1, totalTeammates: 1 };
  const steps = buildReadinessSteps(base);
  assert.deepEqual(steps.map((step) => step.ready), [true, true, true]);
  assert.match(steps[0]!.detail, /1\.18\.31 is ready/);

  const unsupported = buildReadinessSteps({ ...base, compatibility: "unsupported", detectedVersion: "9.9.9" });
  assert.equal(unsupported[0]!.ready, false, "an unverified runtime is never reported ready");
  assert.match(unsupported[0]!.detail, /9\.9\.9 is not verified/);
  assert.match(unsupported[0]!.detail, /1\.18\.31/);

  const checked = buildReadinessSteps({ ...base, compatibility: "checked", detectedVersion: "2.1.4" });
  assert.equal(checked[0]!.ready, true);
  assert.match(checked[0]!.detail, /checked its safety rules automatically/);
  const refused = buildReadinessSteps({ ...base, compatibility: "unsupported", detectedVersion: "2.9.0", compatibilityDetail: "“bash” is not denied for teammates." });
  assert.equal(refused[0]!.ready, false);
  assert.match(refused[0]!.detail, /safety rules.*bash/);
  const patched = buildReadinessSteps({ ...base, compatibility: "compatible", detectedVersion: "1.18.32" });
  assert.equal(patched[0]!.ready, true, "a newer verified-line patch can run");
  assert.match(patched[0]!.detail, /1\.18\.32 is ready.*newer patch/);

  const unknown = buildReadinessSteps({ ...base, cliAvailable: true, compatibility: "unknown", detectedVersion: null });
  assert.equal(unknown[0]!.ready, false);
  assert.match(unknown[0]!.detail, /did not report a version/);

  const missing = buildReadinessSteps({ ...base, cliAvailable: false, compatibility: "unknown", detectedVersion: null });
  assert.equal(missing[0]!.ready, false);
  assert.match(missing[0]!.detail, /Install the OpenCode runtime/);

  const unassigned = buildReadinessSteps({ ...base, readyTeammates: 0, totalTeammates: 2 });
  assert.equal(unassigned[2]!.ready, false);
  assert.match(unassigned[2]!.detail, /Assign a provider and model/);

  const empty = buildReadinessSteps({ ...base, readyTeammates: 0, totalTeammates: 0 });
  assert.equal(empty[2]!.ready, false);
  assert.match(empty[2]!.detail, /Create a teammate/);

  const offline = buildReadinessSteps({ ...base, connectedNames: [] });
  assert.equal(offline[1]!.ready, false);
  assert.match(offline[1]!.detail, /Connect an AI account/);
});
