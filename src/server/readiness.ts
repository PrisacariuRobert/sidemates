import type { ReadinessStep } from "../shared/types.js";
import { runtimeMayExecute, VERIFIED_OPENCODE_VERSION, type RuntimeCompatibility } from "./runtime-compatibility.js";

/** First-run readiness truth (D01). Saved is not ready:
 * - runtime needs the CLI present AND a verified version (an unsupported
 *   runtime fails every dispatch, so reporting it ready strands new users);
 * - connection stays connected-based (probing model access on every poll
 *   would spend allowance and hit the network; the Test button owns that);
 * - a teammate only counts with a provider assignment whose model belongs
 *   to that connection (an unconfigured or post-delete teammate cannot run).
 * Pure: every branch is unit-testable with fixed inputs. */
export function buildReadinessSteps(input: {
  cliAvailable: boolean;
  compatibility: RuntimeCompatibility["compatibility"];
  detectedVersion: string | null;
  /** Why the automatic safety check failed, when it did. */
  compatibilityDetail?: string;
  connectedNames: string[];
  readyTeammates: number;
  totalTeammates: number;
}): ReadinessStep[] {
  const runtimeReady = input.cliAvailable && runtimeMayExecute(input.compatibility);
  const runtimeDetail = !input.cliAvailable
    ? "Install the OpenCode runtime so teammates can work."
    : input.compatibility === "verified"
      ? `OpenCode${input.detectedVersion ? ` ${input.detectedVersion.trim().split("\n")[0]}` : ""} is ready on this host.`
      : input.compatibility === "compatible"
        ? `OpenCode ${input.detectedVersion || ""} is ready on this host (a newer patch of verified ${VERIFIED_OPENCODE_VERSION}).`
      : input.compatibility === "checked"
        ? `OpenCode ${input.detectedVersion || ""} is ready on this host (a newer version; Sidemates checked its safety rules automatically and they hold).`
      : input.compatibility === "unsupported" && input.compatibilityDetail
        ? `OpenCode ${input.detectedVersion || "unknown version"} changed how its safety rules work, so teammates are paused. ${input.compatibilityDetail} Update Sidemates or switch runtimes; files, results, settings and receipts remain available.`
      : input.compatibility === "unsupported"
        ? `OpenCode ${input.detectedVersion || "unknown version"} is not verified with this Sidemates release (verified: ${VERIFIED_OPENCODE_VERSION}). Update Sidemates or switch runtimes; files, results, settings and receipts remain available.`
        : "OpenCode did not report a version just now, so execution readiness is unknown. If this persists, reinstall the runtime and try again.";
  return [
    { id: "runtime", ready: runtimeReady, label: "Model runtime", detail: runtimeDetail },
    {
      id: "connection", ready: input.connectedNames.length > 0,
      label: "AI connection",
      detail: input.connectedNames.length ? `${input.connectedNames.length} connected: ${input.connectedNames.slice(0, 3).join(", ")}.` : "Connect an AI account, key, or local model.",
    },
    {
      id: "teammate", ready: input.readyTeammates > 0,
      label: "First teammate",
      detail: input.readyTeammates > 0
        ? `${input.readyTeammates} teammate${input.readyTeammates === 1 ? "" : "s"} ready.`
        : input.totalTeammates > 0
          ? "Assign a provider and model to a teammate — a saved teammate without one cannot run anything yet."
          : "Create a teammate to start delegating work.",
    },
  ];
}
