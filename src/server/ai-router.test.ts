import assert from "node:assert/strict";
import test from "node:test";
import { AiRest, bestModelFor, classifyJob, isLimitError, rankAi, type AiConnection } from "./ai-router.js";

const claude: AiConnection = { id: "local-claude", provider: "claude", connected: true, models: ["claude-code/sonnet", "claude-code/opus", "claude-code/haiku"] };
const openai: AiConnection = { id: "local-openai", provider: "openai", connected: true, models: ["openai/gpt-5.5", "openai/gpt-5.6", "openai/gpt-5.6-mini", "openai/gpt-5.6-codex"] };
const opencode: AiConnection = { id: "local-opencode", provider: "opencode", connected: true, models: ["opencode/mimo-v2.5-free", "opencode-go/muse-spark-1.3-contributor", "opencode-go/deepseek-v4.1-flash"] };
const google: AiConnection = { id: "local-google", provider: "google", connected: true, models: ["google/gemini-flash-latest", "google/gemini-flash-lite-latest", "google/gemini-2.5-pro"] };

test("small requests are light; browsing, files, schedules and reports are heavy", () => {
  const base = { browserEnabled: true, attachments: 0, routine: false };
  assert.equal(classifyJob({ ...base, prompt: "hi" }), "light");
  assert.equal(classifyJob({ ...base, prompt: "Remind me to call Ana at 5" }), "light");
  assert.equal(classifyJob({ ...base, prompt: "Research three Italian places near Stephansplatz with sources" }), "heavy");
  assert.equal(classifyJob({ ...base, browserEnabled: false, prompt: "Research three Italian places" }), "light", "no browser, nothing to browse");
  assert.equal(classifyJob({ ...base, prompt: "Summarize this", attachments: 1 }), "heavy");
  assert.equal(classifyJob({ ...base, prompt: "Morning brief", routine: true }), "heavy");
  assert.equal(classifyJob({ ...base, prompt: "go", expectedWorkKind: "morning" }), "heavy");
  assert.equal(classifyJob({ ...base, prompt: "x".repeat(400) }), "heavy");
});

test("each connection offers its strong model for big jobs and its fast one for small jobs", () => {
  assert.equal(bestModelFor(claude, "heavy"), "claude-code/sonnet");
  assert.equal(bestModelFor(claude, "light"), "claude-code/haiku");
  assert.equal(bestModelFor(openai, "heavy"), "openai/gpt-5.6");
  assert.equal(bestModelFor(openai, "light"), "openai/gpt-5.6-mini");
  assert.equal(bestModelFor(google, "heavy"), "google/gemini-flash-latest", "a free key lasts longer on Flash than on Pro");
  assert.equal(bestModelFor(google, "light"), "google/gemini-flash-lite-latest");
  assert.equal(bestModelFor(opencode, "heavy"), "opencode-go/deepseek-v4.1-flash");
});

test("never a model that fails for teammates or trains on prompts", () => {
  assert.equal(bestModelFor({ ...opencode, models: ["opencode/mimo-v2.5-free", "opencode-go/muse-spark-1.3-contributor"] }, "heavy"), undefined);
  assert.equal(bestModelFor({ ...opencode, models: [] }, "light"), undefined);
});

test("the strongest AI comes first for big jobs; disconnected and resting ones are skipped", () => {
  assert.deepEqual(rankAi([opencode, google, openai, claude], "heavy").map((pick) => pick.instanceId), ["local-claude", "local-openai", "local-opencode", "local-google"]);
  assert.deepEqual(rankAi([{ ...claude, connected: false }, opencode], "heavy"), [{ instanceId: "local-opencode", model: "opencode-go/deepseek-v4.1-flash" }]);
  assert.deepEqual(rankAi([claude, openai], "heavy", (id) => id === "local-claude").map((pick) => pick.model), ["openai/gpt-5.6"]);
  assert.deepEqual(rankAi([{ ...opencode, models: ["opencode/mimo-v2.5-free"] }], "light"), [], "nothing usable means no pick");
  assert.deepEqual(rankAi([claude, opencode], "light")[0], { instanceId: "local-claude", model: "claude-code/haiku" });
});

test("limit errors are told apart from ordinary failures", () => {
  for (const text of ["429 Too Many Requests", "You've hit your usage limit. Resets at 5pm", "insufficient_quota", "RESOURCE_EXHAUSTED: quota", "rate limited, retry later", "subscription_sharing_usage_limit_exceeded", "Overloaded"]) assert.ok(isLimitError(text), text);
  for (const text of ["Input must be provided", "The page could not be opened", "Permission denied", "limited access to Mail"]) assert.ok(!isLimitError(text), text);
});

test("a connection that hit its limit rests, then comes back", () => {
  let now = 1_000;
  const rest = new AiRest(() => now);
  rest.rest("local-claude", 60_000);
  assert.equal(rest.isResting("local-claude"), true);
  assert.equal(rest.isResting("local-openai"), false);
  now += 60_001;
  assert.equal(rest.isResting("local-claude"), false);
});

test("ChatGPT through Sign in with ChatGPT gets its strong model for big jobs and its small one for small jobs", () => {
  const plan: AiConnection = { id: "chatgpt-plan", provider: "openai", connected: true, models: ["openbot-chatgpt-plan/gpt-5.6-mini", "openbot-chatgpt-plan/gpt-6.1-sol", "openbot-chatgpt-plan/gpt-5.6-luna"] };
  assert.equal(bestModelFor(plan, "heavy"), "openbot-chatgpt-plan/gpt-6.1-sol");
  assert.equal(bestModelFor(plan, "light"), "openbot-chatgpt-plan/gpt-5.6-mini");
});

test("Apple's built-in AI only takes a job when nothing else can", () => {
  const apple: AiConnection = { id: "local-apple", provider: "apple", connected: true, models: ["apple/on-device"] };
  const custom: AiConnection = { id: "local-model", provider: "custom", connected: true, models: ["openbot-local-model/qwen"] };
  assert.deepEqual(rankAi([apple, claude], "light").map((pick) => pick.instanceId), ["local-claude", "local-apple"]);
  assert.deepEqual(rankAi([apple, custom], "heavy").map((pick) => pick.instanceId), ["local-model", "local-apple"]);
  assert.deepEqual(rankAi([apple], "heavy"), [{ instanceId: "local-apple", model: "apple/on-device" }], "With no other AI, the team still works");
  assert.deepEqual(rankAi([apple, claude], "light", (id) => id === "local-claude")[0], { instanceId: "local-apple", model: "apple/on-device" }, "And when the others have run out");
});
