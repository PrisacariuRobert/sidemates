import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { safeHostEnvironment } from "./runtime.js";
import { AMBIENT_DENIED, teammatePermission } from "./teammate-permissions.js";

/** Does the installed OpenCode still read Sidemates' safety rules the way they
 * were written? Pinning one exact version meant every release stopped every
 * teammate until someone re-checked by hand, and OpenCode updates itself. So
 * instead, when a version Sidemates has not seen shows up, it writes the real
 * deny-by-default rules into a throwaway folder, asks OpenCode what it actually
 * resolved, and tests that. No model is called and nothing is spent. It runs
 * once per version. If a rule no longer holds the teammate stays paused, and
 * the reason says which one. */

export interface BoundaryResult { ok: boolean; reasons: string[] }
interface Rule { action: string; resource: string; effect: string }

const FIXTURE_ALLOWED = ["workspace_list", "workspace_read", "workspace_write", "workspace_replace", "task_plan", "web_read", "isolated_bash"];
const REQUIRED_RUN_FLAGS = ["--auto", "--format", "--model", "--agent", "--file", "--session", "--title"];
// A tool that does not exist yet: the default must cover what a future runtime adds.
const FUTURE_TOOL = "zz_future_runtime_tool";

/** Old config: { bash: "deny", edit: { "git *": "allow" } }. New config: a list of rules. Both become rules. */
function rulesFrom(value: unknown): Rule[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({ action: String(item.action ?? ""), resource: String(item.resource ?? "*"), effect: String(item.effect ?? "") }));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([action, rule]) =>
      typeof rule === "string" ? [{ action, resource: "*", effect: rule }]
        : typeof rule === "object" && rule !== null ? Object.entries(rule as Record<string, unknown>).map(([resource, effect]) => ({ action, resource, effect: String(effect) })) : []);
  }
  return [];
}

/** The last rule that names this action wholesale wins. Nothing naming it is
 * "ask", never "deny": with --auto, anything not explicitly denied is approved. */
export function decide(rules: Rule[], action: string): string {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!;
    if ((rule.action === "*" || rule.action === action) && rule.resource === "*") return rule.effect;
  }
  return "ask";
}

/** Pure part of the check: what OpenCode printed for `debug config` and `run --help`. */
export function inspectBoundary(configOutput: string, runHelp: string, agentName = "openbot"): BoundaryResult {
  const reasons: string[] = [];
  let parsed: unknown;
  try { parsed = JSON.parse(configOutput); } catch { return { ok: false, reasons: ["OpenCode did not report its resolved configuration."] }; }
  // 2.x lists every config source; 1.x prints one merged object.
  const documents = (Array.isArray(parsed) ? parsed.map((entry) => (entry as { info?: unknown }).info) : [parsed])
    .filter((info): info is Record<string, unknown> => typeof info === "object" && info !== null);
  const globalRules = documents.flatMap((doc) => rulesFrom(doc.permissions ?? doc.permission));
  const agents = documents.flatMap((doc) => Object.entries((doc.agents ?? doc.agent ?? {}) as Record<string, Record<string, unknown>>).filter(([name]) => name === agentName).map(([, agent]) => agent));
  if (!agents.length) return { ok: false, reasons: [`OpenCode did not load the “${agentName}” teammate agent from the workspace settings.`] };
  const agentRules = agents.flatMap((agent) => rulesFrom(agent.permissions ?? agent.permission));
  if (!documents.some((doc) => doc.default_agent === agentName)) reasons.push(`The “${agentName}” agent is not the default agent for the workspace.`);

  const effective = [...globalRules, ...agentRules];
  for (const action of [...AMBIENT_DENIED, "external_directory", FUTURE_TOOL]) {
    if (decide(effective, action) !== "deny") reasons.push(action === FUTURE_TOOL ? "Tools OpenCode adds in future would not be denied by default." : `“${action}” is not denied for teammates.`);
  }
  for (const action of FIXTURE_ALLOWED) {
    if (decide(effective, action) !== "allow") reasons.push(`The Sidemates tool “${action}” is not allowed, so teammates could not work.`);
  }
  // Nothing may allow a runtime tool outright, anywhere, in any pattern or order.
  const blanket = effective.filter((rule) => rule.effect === "allow" && (rule.action === "*" || AMBIENT_DENIED.includes(rule.action) || rule.action === "external_directory"));
  for (const rule of blanket) reasons.push(`A rule allows “${rule.action}”${rule.resource === "*" ? "" : ` for ${rule.resource}`}.`);

  const missing = REQUIRED_RUN_FLAGS.filter((flag) => !new RegExp(`(^|\\s)${flag}(?![\\w-])`).test(runHelp));
  if (missing.length) reasons.push(`OpenCode no longer offers ${missing.join(", ")}, which Sidemates uses to start teammates.`);
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

type Spawn = (args: string[], cwd: string) => { status: number | null; stdout: string };
const spawnOpenCode: Spawn = (args, cwd) => {
  const result = spawnSync("opencode", args, { cwd, encoding: "utf8", timeout: 30_000, env: safeHostEnvironment() });
  return { status: result.status, stdout: String(result.stdout || "") };
};

export function checkOpencodeBoundary(spawn: Spawn = spawnOpenCode): BoundaryResult {
  const dir = mkdtempSync(path.join(tmpdir(), "sidemates-boundary-"));
  try {
    const permission = teammatePermission(FIXTURE_ALLOWED);
    writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json", permission, default_agent: "openbot",
      agent: { openbot: { mode: "primary", description: "Sidemates' scoped teammate runtime", prompt: "boundary check", permission } },
    }), "utf8");
    const config = spawn(["debug", "config"], dir);
    if (config.status !== 0) return { ok: false, reasons: ["OpenCode could not report its configuration, so its safety rules cannot be confirmed."] };
    const help = spawn(["run", "--help"], dir);
    return inspectBoundary(config.stdout, help.stdout);
  } catch {
    return { ok: false, reasons: ["The safety check could not run on this Mac."] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
