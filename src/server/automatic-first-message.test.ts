import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AppState, Bot } from "../shared/types.js";

// The team was made before any AI was signed in (or before the first check
// finished). Once Claude is signed in, the team must be able to send its
// first message without anyone choosing an AI.
test("teammates on Automatic get an AI as soon as one is connected", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sidemates-automatic-first-"));
  const bin = path.join(root, "bin"), signedIn = path.join(root, "signed-in");
  mkdirSync(bin);
  // A stand-in Claude Code that is installed but signed out until the flag file exists.
  writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.226 (Claude Code)"; exit 0; fi\nif [ "$1" = "auth" ]; then if [ -f "${signedIn}" ]; then echo '{"loggedIn":true}'; else echo '{"loggedIn":false}'; fi; exit 0; fi\nexit 1\n`);
  chmodSync(path.join(bin, "claude"), 0o755);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const base = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin`, OPENBOT_LOAD_ENV: "0", OPENBOT_APPLE_AI: "off", OPENBOT_DATA_DIR: path.join(root, "data"), OPENBOT_PORT: String(address.port), OPENBOT_APP_URL: base, OPENBOT_HOST: "127.0.0.1", OPENBOT_DEPLOYMENT_MODE: "local", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit"); let log = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { log = (log + chunk).slice(-3_000); });
  const teamAi = async () => ((await (await fetch(base + "/api/state")).json()) as AppState).bots.map((bot) => [bot.name, bot.providerInstanceId, bot.model]);
  try {
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(base + "/api/healthz", { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Starting. */ }
      if (child.exitCode !== null || attempt >= 200) throw new Error(log || "The studio did not start.");
      await delay(100);
    }
    await fetch(base + "/api/provider");
    const installed = await fetch(base + "/api/team-templates/your-team/install", { method: "POST" });
    assert.equal(installed.status, 201, await installed.clone().text());
    assert.ok(((await installed.json()) as { bots: Bot[] }).bots.every((bot) => bot.aiMode === "automatic" && !bot.providerInstanceId), "No AI yet: Claude is signed out");

    writeFileSync(signedIn, "yes");
    await delay(15_500); // The connection check is cached for 15 seconds.
    const status = (await (await fetch(base + "/api/provider")).json()) as { catalog: Array<{ id: string; connected: boolean }> };
    assert.ok(status.catalog.some((entry) => entry.id === "claude" && entry.connected), "Claude now reads as signed in");
    const team = await teamAi();
    assert.deepEqual(team.map(([name]) => name).sort(), ["Nova", "Pixel", "Scout"]);
    assert.ok(team.every(([, id, model]) => id === "local-claude" && String(model).startsWith("claude-code/")), `Every teammate can send its first message: ${JSON.stringify(team)}`);
  } finally {
    child.kill("SIGTERM"); await Promise.race([exited, delay(4_000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await exited; }
    rmSync(root, { recursive: true, force: true });
  }
});
