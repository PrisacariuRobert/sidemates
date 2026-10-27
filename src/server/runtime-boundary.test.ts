import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { checkOpencodeBoundary, checkOpencodeSafetyRules, decide, inspectBoundary, usesToolServer } from "./runtime-boundary.js";
import { AMBIENT_DENIED, teammatePermission } from "./teammate-permissions.js";

const allowed = ["workspace_list", "workspace_read", "workspace_write", "workspace_replace", "task_plan", "web_read", "isolated_bash"];
const HELP = "FLAGS\n  --auto  x\n  --format choice\n  --model, -m string\n  --agent string\n  --file, -f string\n  --session, -s string\n  --title string\n";
const toRules = (permission: Record<string, string>) => Object.entries(permission).map(([action, effect]) => ({ action, resource: "*", effect }));
/** What OpenCode 2.x prints for `debug config`: a list of sources with rule lists. */
const modern = (agentRules: unknown[], global: unknown[] = [], extra: Record<string, unknown> = {}) => JSON.stringify([
  { type: "document", path: "/home/u/.config/opencode/opencode.jsonc", info: { providers: {} } },
  { type: "document", path: "/w/opencode.json", info: { default_agent: "openbot", permissions: global, agents: { openbot: { mode: "primary", permissions: agentRules } }, ...extra } },
]);
/** What 1.x printed: one merged object with permission maps. */
const legacy = (permission: Record<string, unknown>) => JSON.stringify({ default_agent: "openbot", permission, agent: { openbot: { mode: "primary", permission } } });
const good = toRules(teammatePermission(allowed));

test("the deny-by-default rules pass in both the new and the old config format", () => {
  assert.deepEqual(inspectBoundary(modern(good), HELP), { ok: true, reasons: [] });
  assert.deepEqual(inspectBoundary(legacy(teammatePermission(allowed)), HELP), { ok: true, reasons: [] });
});

test("a rule that is missing, reordered or loosened is caught, with the reason", () => {
  const without = (action: string) => good.filter((rule) => rule.action !== action);
  const fails = (output: string, pattern: RegExp, help = HELP) => { const result = inspectBoundary(output, help); assert.equal(result.ok, false, `should fail: ${pattern}`); assert.match(result.reasons.join(" | "), pattern); };
  fails(modern(without("*")), /future|not denied/i);
  assert.equal(inspectBoundary(modern(without("external_directory")), HELP).ok, true, "still covered by the default deny");
  fails(modern([...good, { action: "external_directory", resource: "*", effect: "allow" }]), /external_directory/);
  fails(modern([...good, { action: "bash", resource: "*", effect: "allow" }]), /bash/);
  fails(modern([...good, { action: "*", resource: "*", effect: "allow" }]), /allows “\*”|not denied/);
  fails(modern([...good, { action: "edit", resource: "src/**", effect: "allow" }]), /edit/);
  fails(modern(good, [{ action: "webfetch", resource: "*", effect: "allow" }]), /webfetch/);
  fails(modern(without("workspace_read")), /workspace_read/);
  fails(modern(good, [], { default_agent: "build" }), /default agent/);
  fails(JSON.stringify([{ type: "document", info: { default_agent: "openbot" } }]), /did not load/);
  fails("not json", /did not report/);
  fails(modern(good), /--auto/, HELP.replace("--auto  x\n", ""));
  fails(modern(good), /--agent/, HELP.replace("--agent string\n", ""));
});

test("an action no rule names is not treated as denied, because --auto approves it", () => {
  assert.equal(decide([], "bash"), "ask");
  assert.equal(decide([{ action: "*", resource: "*", effect: "deny" }, { action: "bash", resource: "git *", effect: "allow" }], "bash"), "deny", "a pattern-only allow does not decide the whole action");
  assert.equal(decide(good, "bash"), "deny");
  assert.equal(decide(good, "workspace_read"), "allow");
  assert.equal(decide(good, "something_new_in_3_0"), "deny");
  assert.ok(AMBIENT_DENIED.includes("bash") && AMBIENT_DENIED.includes("webfetch") && AMBIENT_DENIED.includes("task"));
});

test("report-only teammates keep their narrower rules", () => {
  assert.deepEqual(teammatePermission(allowed, true), { "*": "deny", work_collect: "allow", openbot_work_collect: "allow", work_report: "allow", openbot_work_report: "allow" });
  assert.equal(teammatePermission(allowed)["external_directory"], "deny");
});

test("each tool is allowed by its plain name and its OpenCode 2.x name, never by a wildcard", () => {
  const rules = teammatePermission(allowed);
  assert.equal(rules["workspace_read"], "allow");
  assert.equal(rules["openbot_workspace_read"], "allow");
  assert.ok(!Object.keys(rules).some((name) => name.includes("*") && name !== "*"), "no pattern rule opens a family of tools");
  assert.equal(decide(good, "openbot_gmail_send"), "deny", "a tool that is not listed stays denied");
  const open = inspectBoundary(modern([...good, { action: "openbot_zz_future_runtime_tool", resource: "*", effect: "allow" }]), HELP);
  assert.equal(open.ok, false);
  assert.match(open.reasons.join(" "), /not listed would not be denied/);
  const missing = inspectBoundary(modern(good.filter((rule) => rule.action !== "openbot_workspace_read")), HELP);
  assert.match(missing.reasons.join(" "), /openbot_workspace_read/);
});

test("only the newer OpenCode generation gets the tool-reach check", () => {
  assert.equal(usesToolServer(modern(good)), true);
  assert.equal(usesToolServer(legacy(teammatePermission(allowed))), false, "the older generation loads tool files");
  assert.equal(usesToolServer("not json"), false);
});

test("a newer OpenCode whose tools cannot be reached is reported with the reason; the older one is not probed", () => {
  const spawnFake = (args: string[]) => ({ status: 0, stdout: args[0] === "debug" ? modern(good) : HELP });
  const blocked = checkOpencodeBoundary(spawnFake, () => ({ ok: false, reason: "Sidemates' tool server did not connect to this OpenCode." }));
  assert.equal(blocked.ok, false);
  assert.match(blocked.reasons[0]!, /did not connect/);
  assert.equal(checkOpencodeBoundary(spawnFake, () => ({ ok: true })).ok, true);
  let probed = 0;
  const oldGeneration = (args: string[]) => ({ status: 0, stdout: args[0] === "debug" ? legacy(teammatePermission(allowed)) : HELP });
  // FIXTURE_ALLOWED matches `allowed`, so the older generation passes without a probe.
  assert.equal(checkOpencodeBoundary(oldGeneration, () => { probed += 1; return { ok: false }; }).ok, true);
  assert.equal(probed, 0);
  // Unsafe rules never reach the tool server.
  const unsafe = (args: string[]) => ({ status: 0, stdout: args[0] === "debug" ? modern([...good, { action: "bash", resource: "*", effect: "allow" }]) : HELP });
  assert.equal(checkOpencodeBoundary(unsafe, () => { probed += 1; return { ok: true }; }).ok, false);
  assert.equal(probed, 0);
});

const installed = (() => { try { return spawnSync("opencode", ["--version"], { timeout: 10_000 }).status === 0; } catch { return false; } })();
test("the installed OpenCode, whatever its version, keeps the deny-by-default rules", { skip: !installed, timeout: 60_000 }, () => {
  const result = checkOpencodeSafetyRules();
  assert.equal(result.ok, true, `OpenCode no longer reads Sidemates' safety rules as written: ${result.reasons.join(" | ")}`);
  // The full verdict adds a real tool-reach check on the newer generation: tools connect and the rules apply to them.
  const full = checkOpencodeBoundary();
  assert.equal(full.ok, true, `A teammate could not reach its tools: ${full.reasons.join(" | ")}`);
});
