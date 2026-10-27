// Bounded live connection probe: does this provider actually serve models right now?
// Saved credentials alone must never read as "Ready" — only a real reply counts.
// The probe asks for one exact token, reports access (never secrets, keys, URLs,
// or raw provider text), and persists a receipt the UI can show beside "Saved".
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelOutput } from "./model-output.js";
import { safeHostEnvironment } from "./runtime.js";
import { standaloneArgs } from "./opencode-flags.js";

export const PROBE_TOKEN = "OPENBOT_OK";
export const PROBE_TIMEOUT_MS = 90_000;
export const PROBE_COOLDOWN_MS = 60_000;

export interface ProviderProbeResult {
  ok: boolean;
  model: string;
  latencyMs: number;
  error: string | null;
  testedAt: string;
}

export type ProbeSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export function probeAllowed(lastTestedAt: string | null, now = Date.now()): boolean {
  if (!lastTestedAt) return true;
  return now - Date.parse(lastTestedAt) >= PROBE_COOLDOWN_MS;
}

function safeProbeError(message: string): string {
  if (/timed out|ETIMEDOUT/i.test(message)) return "The connection test timed out. The provider may be slow or unreachable; try again, or choose another model.";
  if (/ENOENT|not found|not installed/i.test(message)) return "The model runtime is not installed on this host, so the test could not run.";
  if (/rate.limit|quota|usage.limit|insufficient.credit|429/i.test(message)) return "The provider reached a usage or rate limit. Wait for its allowance to reset, then test again.";
  if (/401|403|unauthorized|forbidden|rejected.*(sign|access|key)/i.test(message)) return "The provider rejected its sign-in or key. Reconnect it, then test again.";
  if (/500|502|503|504|unavailable|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed/i.test(message)) return "The provider is unreachable or temporarily unavailable. Check the connection, then test again.";
  return "The provider did not answer the connection test. Check the connection, then test again.";
}

export async function probeProviderModel(model: string, extraEnv: Record<string, string> = {}, spawnProcess: ProbeSpawn = spawn, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProviderProbeResult> {
  const started = Date.now();
  const workspace = mkdtempSync(path.join(tmpdir(), "openbot-provider-probe-"));
  const finish = (ok: boolean, error: string | null): ProviderProbeResult => {
    rmSync(workspace, { recursive: true, force: true });
    // testedAt marks completion: a slow probe must not arrive with its own
    // cooldown already expired, or rapid retests would each burn another run.
    return { ok, model, latencyMs: Date.now() - started, error, testedAt: new Date().toISOString() };
  };
  let child: ChildProcess;
  try {
    // No --dir: OpenCode 2.x dropped it. The process starts in the throwaway folder (cwd), which it uses as its project.
    child = spawnProcess("opencode", ["run", "--format", "json", "--model", model, ...standaloneArgs(), `Reply with the exact text ${PROBE_TOKEN} on its own line. Do not call any tools.`],
      { cwd: workspace, stdio: ["ignore", "pipe", "pipe"], env: safeHostEnvironment({ ...extraEnv, OPENCODE_DISABLE_SHARE: "true" }) });
  } catch {
    return finish(false, safeProbeError("runtime not installed"));
  }
  const output = new ModelOutput("opencode");
  let stderr = "";
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean, error: string | null) => { if (!settled) { settled = true; resolve(finish(ok, error)); } };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } done(false, safeProbeError("timed out")); }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: unknown) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { output.add(JSON.parse(line) as Record<string, unknown>); }
        catch { stderr = `${stderr}\n${line}`.slice(-4_000); }
      }
    });
    child.stderr?.on("data", (chunk: unknown) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
    child.on("error", () => { clearTimeout(timer); done(false, safeProbeError("runtime not installed")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = output.finalText;
      if (code === 0 && text.includes(PROBE_TOKEN)) done(true, null);
      else done(false, safeProbeError(output.failure || stderr || `exit ${code}`));
    });
  });
}
