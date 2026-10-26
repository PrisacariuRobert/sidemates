import { spawnSync } from "node:child_process";
import { safeHostEnvironment } from "./runtime.js";
import { checkOpencodeBoundary, type BoundaryResult } from "./runtime-boundary.js";

/** Gate 1a: pin the verified OpenCode runtime. The runtime version is part of
 * the security boundary, so an unverified version fails closed for model
 * execution without disabling the rest of Sidemates.
 *
 * Verified 1.18.31 (2026-09-19) against the 1.18.30 baseline: upstream
 * changelog is ACP session-option restore, TUI auth-error display, Copilot
 * thinking summarization, console batch endpoints and a gateway dep bump —
 * no permission-model, tool-dispatch, agent-allowlist, MCP-config or CLI
 * flag-surface change affecting Sidemates' boundary. `opencode run` flags
 * Sidemates uses (--auto, --format, --model, --dir, --agent, --file,
 * --session, --title) verified present on the installed 1.18.31 binary,
 * plus a live routine run on this host. */
export const VERIFIED_OPENCODE_VERSION = "1.18.31";

export interface RuntimeCompatibility {
  runtime: "opencode";
  detectedVersion: string | null;
  /** "checked": a version Sidemates has not seen, whose safety rules passed the automatic check (runtime-boundary.ts). */
  compatibility: "verified" | "compatible" | "checked" | "unsupported" | "unknown";
  /** Why a version failed the automatic check, in plain words. */
  detail?: string;
}

/** A newer patch in the verified major.minor line is compatible: OpenCode
 * ships patches often (and self-updates), and failing closed on each one
 * stopped every teammate until Sidemates itself was re-released. A different
 * major/minor, an older patch or an unparseable version still fails closed. */
export function classifyOpencodeVersion(version: string): RuntimeCompatibility["compatibility"] {
  if (version === VERIFIED_OPENCODE_VERSION) return "verified";
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())?.slice(1).map(Number);
  const detected = parse(version);
  const verified = parse(VERIFIED_OPENCODE_VERSION)!;
  if (!detected) return "unsupported";
  return detected[0] === verified[0] && detected[1] === verified[1] && detected[2] > verified[2] ? "compatible" : "unsupported";
}

export function runtimeMayExecute(compatibility: RuntimeCompatibility["compatibility"]): boolean {
  return compatibility === "verified" || compatibility === "compatible" || compatibility === "checked";
}

export const RUNTIME_INCOMPATIBLE_MESSAGE =
  "OpenCode runtime not verified. Sidemates detected an unsupported OpenCode version; this release is verified with 1.18.31. Teammate execution is paused because runtime permission behavior may have changed. Update Sidemates or use the supported runtime. Files, results, settings and receipts remain available.";

let cached: RuntimeCompatibility | null = null;

/** One automatic safety check per version per run of Sidemates. */
const boundaryVerdicts = new Map<string, BoundaryResult>();
export function resetBoundaryVerdictsForTests() { boundaryVerdicts.clear(); }

export function opencodeCompatibility(options: { refresh?: boolean; probe?: () => string | null; boundaryCheck?: () => BoundaryResult } = {}): RuntimeCompatibility {
  if (cached && !options.refresh) return cached;
  // A declared version (set by controlled fixtures) is still validated against
  // the verified version — this is not a bypass.
  const declared = (process.env.OPENBOT_OPENCODE_VERSION || "").trim();
  if (declared) {
    cached = { runtime: "opencode", detectedVersion: declared, compatibility: classifyOpencodeVersion(declared) };
    return cached;
  }
  const readVersion = options.probe || (() => {
    // Never depend on the ambient PATH: GUI/daemon launches often sanitize it
    // down to /usr/bin:/bin, which hides the user's runtime installs and would
    // wedge every task on a healthy host.
    const result = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 10_000, env: safeHostEnvironment() });
    return `${result.stdout || ""}`.trim().split(/\s+/).filter(Boolean).pop() || null;
  });
  let version: string | null = null;
  try {
    version = readVersion();
  } catch {
    version = null;
  }
  let next: RuntimeCompatibility = version
    ? { runtime: "opencode", detectedVersion: version, compatibility: classifyOpencodeVersion(version) }
    : { runtime: "opencode", detectedVersion: null, compatibility: "unknown" };
  // A version we have not been told about is not blocked just for being new:
  // the rules that keep teammates inside their limits are tested directly. An
  // injected probe means a test is driving the version, so no real check then.
  const boundaryCheck = options.boundaryCheck ?? (options.probe ? undefined : checkOpencodeBoundary);
  if (version && next.compatibility === "unsupported" && boundaryCheck) {
    const verdict = boundaryVerdicts.get(version) ?? boundaryCheck();
    boundaryVerdicts.set(version, verdict);
    next = verdict.ok
      ? { runtime: "opencode", detectedVersion: version, compatibility: "checked" }
      : { runtime: "opencode", detectedVersion: version, compatibility: "unsupported", detail: verdict.reasons.join(" ") };
  }
  // A transient probe failure must not wedge the host: only definitive
  // verdicts are cached, so the next task re-probes instead of failing
  // forever on one bad reading.
  cached = next.compatibility === "unknown" ? null : next;
  return next;
}
