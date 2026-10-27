import { spawnSync } from "node:child_process";

/** OpenCode 2.x runs `opencode run` against one shared background service by
 * default, which ignores a run's own environment (private HOME, API-key and
 * local-model settings). `--standalone` gives the run its own private server.
 * Older versions do not know the flag and reject it, so it is only added when
 * `opencode run --help` lists it. The answer is asked once and remembered. */
let cached: string[] | null = null;
export function standaloneArgs(read: () => string = () => {
  try { return String(spawnSync("opencode", ["run", "--help"], { encoding: "utf8", timeout: 10_000 }).stdout || ""); } catch { return ""; }
}): string[] {
  if (cached) return cached;
  cached = /(^|\s)--standalone(?![\w-])/.test(read()) ? ["--standalone"] : [];
  return cached;
}
export function resetStandaloneArgsForTests() { cached = null; }
