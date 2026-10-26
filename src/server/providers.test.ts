import test from "node:test";
import assert from "node:assert/strict";
import {
  oauthMethodIndex,
  ProviderConnectionManager,
  createProviderStatusReader,
  steadyCheck,
  checkTimeout,
} from "./providers.js";
import type { OpenBotDatabase } from "./database.js";
import type { ProviderInstance, ProviderStatus } from "../shared/types.js";

test("coalesces repeated status polling and refreshes when a key or login state changes", async () => {
  let calls = 0;
  const entries: ProviderInstance[] = [];
  const db = { listProviders: () => entries } as unknown as OpenBotDatabase;
  const read = createProviderStatusReader(async () => {
    calls += 1;
    return { version: String(calls) } as ProviderStatus;
  });
  await Promise.all([read(db), read(db), read(db)]);
  assert.equal(calls, 1);
  await read(db);
  assert.equal(calls, 1);
  entries.push({
    id: "saved-key",
    authMode: "api_key",
    updatedAt: "now",
  } as ProviderInstance);
  await read(db);
  assert.equal(calls, 2);
  await read(db, [
    {
      id: "login",
      providerId: "openai",
      status: "connected",
      url: null,
      callbackMode: null,
      instructions: "",
      error: null,
    },
  ]);
  assert.equal(calls, 3);
});

test("a failed status probe can be retried instead of staying cached", async () => {
  let calls = 0;
  const db = { listProviders: () => [] } as unknown as OpenBotDatabase;
  const read = createProviderStatusReader(async () => {
    if (++calls === 1) throw new Error("temporary failure");
    return {} as ProviderStatus;
  });
  await assert.rejects(read(db), /temporary/);
  await read(db);
  assert.equal(calls, 2);
});

test("selects an advertised OAuth method instead of assuming method zero", () => {
  assert.equal(
    oauthMethodIndex([{ type: "api" }, { type: "oauth", label: "Account" }]),
    1,
  );
  assert.throws(() => oauthMethodIndex([{ type: "api" }]), /API key/);
  assert.throws(() => oauthMethodIndex(undefined), /API key/);
});

test("automatic login finishes its callback and updates the attempt", async () => {
  let complete!: () => void;
  const calls: unknown[] = [];
  const bridge = {
    authorize: async () => ({
      url: "https://example.com/login",
      method: "auto" as const,
      instructions: "Sign in",
      methodIndex: 2,
    }),
    callback: async (...args: unknown[]) => {
      calls.push(args);
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
    },
    setApiKey: async () => {},
    stop() {},
  };
  const manager = new ProviderConnectionManager(() => {}, bridge);
  const attempt = await manager.connect("openai");
  assert.equal(attempt.status, "waiting");
  assert.equal((await manager.connect("openai")).id, attempt.id);
  assert.deepEqual(calls, [["openai", 2]]);
  complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.listAttempts()[0]?.status, "connected");
});

test("manual codes keep the selected method and unsupported login returns a visible failure", async () => {
  const calls: unknown[] = [];
  const manager = new ProviderConnectionManager(() => {}, {
    authorize: async (id) => {
      if (id === "xai") throw new Error("Use an API key instead.");
      return {
        url: "https://example.com/login",
        method: "code",
        instructions: "Paste code",
        methodIndex: 1,
      };
    },
    callback: async (...args) => {
      calls.push(args);
    },
    setApiKey: async () => {},
    stop() {},
  });
  const attempt = await manager.connect("openai");
  await manager.finish(attempt.id, "fixture-code");
  assert.deepEqual(calls, [["openai", 1, "fixture-code"]]);
  const unsupported = await manager.connect("xai");
  assert.equal(unsupported.status, "failed");
  assert.equal(unsupported.error, "Use an API key instead.");
});

test("pasting an OpenCode Go key saves it through OpenCode and never keeps it", async () => {
  const saved: Array<[string, string]> = [];
  let changes = 0;
  const manager = new ProviderConnectionManager(() => { changes++; }, {
    authorize: async () => { throw new Error("not used"); },
    callback: async () => {},
    setApiKey: async (providerId, key) => { saved.push([providerId, key]); },
    stop() {},
  });
  await assert.rejects(manager.saveKey("opencode-go", "short"), /doesn't look like an OpenCode key/);
  await assert.rejects(manager.saveKey("opencode-go", "has spaces in it which keys never have"), /doesn't look like/);
  const attempt = await manager.saveKey("opencode-go", "  sk-abcdefghijklmnopqrstuvwxyz0123  ");
  assert.deepEqual(saved, [["opencode-go", "sk-abcdefghijklmnopqrstuvwxyz0123"]]);
  assert.equal(attempt.status, "connected");
  assert.equal(changes, 1);
  assert.ok(!JSON.stringify(manager.listAttempts()).includes("sk-abcdef"), "the key is never kept in attempts");
});

test("an OpenCode connection never defaults to a model that answers 403 for teammate runs", async () => {
  const { preferredModel, modelsFor } = await import("./providers.js");
  assert.deepEqual(modelsFor("opencode", []), [], "no free-tier stand-ins when OpenCode lists nothing");
  assert.deepEqual(modelsFor("opencode", ["opencode/mimo-v2.5-free", "openai/gpt-5.6"]), ["opencode/mimo-v2.5-free"]);
  assert.equal(preferredModel("opencode", ["opencode/mimo-v2.5-free", "opencode/nemotron-3-ultra-free"]), undefined);
  assert.equal(preferredModel("opencode", ["opencode/mimo-v2.5-free", "opencode-go/muse-spark-1.3-contributor", "opencode-go/deepseek-v4.1-flash"]), "opencode-go/deepseek-v4.1-flash");
  assert.equal(preferredModel("opencode", ["opencode-go/muse-spark-1.3-contributor", "opencode-go/glm-5.3-flash"]), "opencode-go/glm-5.3-flash", "a model that doesn't train on prompts comes first");
  assert.equal(preferredModel("opencode", ["opencode/mimo-v2.5-free", "opencode-go/muse-spark-1.3-contributor"]), "opencode-go/muse-spark-1.3-contributor", "the only usable model, labelled in the picker");
});

test("provider status explains an OpenCode sign-in with no usable models and describes Claude plainly", async () => {
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { OpenBotDatabase } = await import("./database.js");
  const { readProviderStatus, OPENCODE_NO_MODELS_NOTE } = await import("./providers.js");
  const root = mkdtempSync(path.join(tmpdir(), "sidemates-provider-status-")), bin = path.join(root, "bin");
  mkdirSync(bin);
  // Fake CLIs: OpenCode is signed in but lists no models; Claude Code is signed in.
  writeFileSync(path.join(bin, "opencode"), '#!/bin/sh\ncase "$1" in\n  --version) echo 1.18.31 ;;\n  auth) echo "OpenCode Go api" ;;\nesac\n', { mode: 0o700 });
  writeFileSync(path.join(bin, "claude"), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.0 (Claude Code)" ;;\n  auth) echo \'{"loggedIn":true}\' ;;\nesac\n', { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  const db = new OpenBotDatabase(root);
  try {
    const status = await readProviderStatus(db);
    const opencode = status.instances.find((instance) => instance.id === "local-opencode");
    assert.ok(opencode, "the OpenCode sign-in is found");
    assert.deepEqual(opencode.models, []);
    assert.equal(opencode.defaultModel, undefined);
    assert.equal(opencode.note, OPENCODE_NO_MODELS_NOTE);
    const claude = status.catalog.find((entry) => entry.id === "claude");
    assert.ok(claude?.connected);
    assert.doesNotMatch(`${claude.badge} ${claude.description}`, /official/i, "no wording that reads as Anthropic's endorsement");
    assert.match(claude.description, /Claude Code you installed and signed in to/);
    const card = status.catalog.find((entry) => entry.id === "opencode");
    assert.doesNotMatch(`${card?.badge} ${card?.description}`, /free/i, "OpenCode's free models can't run teammates");
  } finally {
    process.env.PATH = previousPath;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a slow AI check keeps the last answer, so connected AIs don't vanish from the list", async () => {
  const signedIn = { code: 0, stdout: "OpenAI oauth\nOpenCode Zen api", stderr: "" };
  assert.deepEqual(await steadyCheck("fixture auth", async () => signedIn), signedIn);
  assert.deepEqual(await steadyCheck("fixture auth", async () => ({ code: 1, stdout: "", stderr: "", timedOut: true })), signedIn, "A timeout says nothing about the connection");
  const signedOut = { code: 1, stdout: "", stderr: "Not signed in" };
  assert.deepEqual(await steadyCheck("fixture auth", async () => signedOut), signedOut, "A real answer always replaces the last one");
  const first = { code: 1, stdout: "", stderr: "", timedOut: true };
  assert.deepEqual(await steadyCheck("fixture never answered", async () => first), first, "With nothing to fall back on, the timeout stands");
});

test("the first check of a program waits longer, later ones don't", async () => {
  assert.equal(checkTimeout("fixture first launch"), 60_000, "A just-installed program may be inspected by macOS on its first run");
  await steadyCheck("fixture first launch", async () => ({ code: 0, stdout: "1.18.31", stderr: "" }));
  assert.equal(checkTimeout("fixture first launch"), 15_000);
});

test("OpenCode sign-ins are found in the current and the older list wording", async () => {
  const { openCodeSignIns } = await import("./providers.js");
  // OpenCode 2.x: a table of provider, kind and state.
  const current = "OpenAI            API key                     stored\nOpenCode Console  API key                     stored\n";
  assert.deepEqual(openCodeSignIns(current), { opencode: true, openai: true, copilot: false, gitlab: false, xai: false, google: false });
  // Older versions: bullets, box lines and short kinds.
  const older = "\u250c  Credentials ~/.local/share/opencode/auth.json\n\u2502\n\u25cf  OpenCode Zen api\n\u2502\n\u25cf  GitHub Copilot oauth\n\u2502\n\u25cf  Google api\n\u2514  3 credentials\n";
  assert.deepEqual(openCodeSignIns(older), { opencode: true, openai: false, copilot: true, gitlab: false, xai: false, google: true });
  const goOnly = "\u001b[32mOpenCode Go\u001b[0m  api  stored";
  assert.equal(openCodeSignIns(goOnly).opencode, true);
  // Nothing stored, or a different product with a similar name, is not a sign-in.
  assert.deepEqual(openCodeSignIns("No credentials found\n0 credentials\n"), { opencode: false, openai: false, copilot: false, gitlab: false, xai: false, google: false });
  assert.equal(openCodeSignIns("OpenCodeX  API key  stored").opencode, false);
});

