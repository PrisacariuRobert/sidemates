import type { Run } from "../shared/types";

const contextRunTime = (run: Run) => {
  const timestamps = [run.progressAt, run.finishedAt, run.startedAt]
    .map((value) => value ? Date.parse(value) : Number.NEGATIVE_INFINITY)
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : Number.NEGATIVE_INFINITY;
};

/** Keep active/current work first while preserving older runs as history. */
export function orderContextRuns(runs: Run[]): Run[] {
  return [...runs].sort((a, b) => {
    const active = (status: Run["status"]) => ["queued", "running", "awaiting_approval", "waiting_for_teammate"].includes(status);
    return Number(active(b.status)) - Number(active(a.status)) || contextRunTime(b) - contextRunTime(a);
  });
}

/** What the Details list shows for a run. Follow-up runs started by an
 * approval carry an internal sentence as their goal; show it in plain words. */
export function contextRunTitle(run: Run): string {
  const text = (run.task?.goal || run.prompt || "").replace(/\s+/g, " ").trim();
  if (/^the user approved the requested action/i.test(text)) return "Carried out the action you approved";
  return text || "Untitled work";
}

export type ContextRunState = "review" | "active" | "done" | "failed" | "idle";
export function contextRunState(run: Run): { state: ContextRunState; label: string } {
  if (run.status === "awaiting_approval") return { state: "review", label: "Needs your review" };
  if (run.status === "completed") return { state: "done", label: "Finished" };
  if (run.status === "failed") return { state: "failed", label: "Needs a hand" };
  if (run.status === "waiting_for_teammate") return { state: "active", label: "Consulting the team" };
  if (run.status === "running" || run.status === "queued") return { state: "active", label: run.status === "queued" ? "Waiting to start" : "Working" };
  if (run.status === "cancelled") return { state: "idle", label: "Stopped" };
  return { state: "idle", label: String(run.status) };
}
