import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The command-line options Sidemates passes to Claude Code on every run. If
 * an update drops or renames one, the run would fail with a cryptic error, so
 * this is checked first and explained in plain words. */
export const CLAUDE_REQUIRED_FLAGS = [
  "--output-format", "--verbose", "--include-partial-messages", "--model", "--permission-mode", "--tools",
  "--system-prompt", "--setting-sources", "--mcp-config", "--strict-mcp-config", "--allowedTools", "--resume",
];
/** The tools every Claude run is allowed to use through Sidemates' own tool server. */
export const CLAUDE_REQUIRED_TOOLS = ["workspace_list", "work_collect", "work_report"];

export type ClaudeHealth = { ok: boolean; version: string | null; problems: string[] };

export function inspectClaudeHelp(help: string): string[] {
  const problems = CLAUDE_REQUIRED_FLAGS
    .filter((flag) => !new RegExp(`${flag}(?![\\w-])`).test(help))
    .map((flag) => `Claude Code no longer has the ${flag} option Sidemates relies on.`);
  if (!problems.length && !/dontAsk/.test(help)) problems.push("Claude Code no longer offers the \"don't ask\" permission mode that keeps teammates inside their limits.");
  return problems;
}

const bridgePath = fileURLToPath(new URL("./claude-mcp.mjs", import.meta.url));

/** Starts Sidemates' tool server the way Claude Code does and asks for its tools. No model is used. */
export function probeClaudeToolServer(): string[] {
  const workspace = mkdtempSync(path.join(tmpdir(), "sidemates-claude-health-"));
  try {
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "health", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];
    const result = spawnSync(process.execPath, [bridgePath], { env: { PATH: process.env.PATH || "", OPENBOT_WORKSPACE: workspace }, input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n", encoding: "utf8", timeout: 8_000 });
    if (result.status !== 0) return ["Sidemates' tool server could not start for Claude."];
    let names: string[] = [];
    try {
      const reply = result.stdout.trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.id === 2);
      names = (reply?.result?.tools || []).map((tool: { name: string }) => tool.name);
    } catch { return ["Sidemates' tool server gave Claude an answer it could not read."]; }
    const missing = CLAUDE_REQUIRED_TOOLS.filter((name) => !names.includes(name));
    return missing.length ? [`Sidemates' tool server is missing ${missing.join(", ")}.`] : [];
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

type Verdict = { version: string; health: ClaudeHealth };
let remembered: Verdict | null = null;
export function resetClaudeHealthForTests() { remembered = null; }

/** One automatic check per Claude Code version per run of Sidemates. */
export function claudeHealth(version: string, readHelp: () => string, probeTools: () => string[] = probeClaudeToolServer): ClaudeHealth {
  if (remembered?.version === version) return remembered.health;
  const help = readHelp();
  // An unreadable help screen is not proof of a problem, and is not remembered.
  if (!help.trim()) return { ok: true, version, problems: [] };
  const problems = [...inspectClaudeHelp(help), ...probeTools()];
  const health: ClaudeHealth = { ok: problems.length === 0, version, problems };
  remembered = { version, health };
  return health;
}

export function claudeHealthMessage(health: ClaudeHealth): string {
  return `Claude Code ${health.version ?? ""} changed in a way Sidemates has not caught up with, so teammates on Claude are paused. ${health.problems.join(" ")} Update Sidemates, or pick another AI for these teammates in the meantime.`.replace(/\s+/g, " ");
}

/** Reads `claude --help` on this Mac for the automatic check. */
export function readClaudeHelp(env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync("claude", ["--help"], { encoding: "utf8", timeout: 10_000, env });
  return result.status === 0 ? `${result.stdout || ""}` : "";
}
