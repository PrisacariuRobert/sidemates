/** The runtime's own file, shell and network tools. They are never enabled:
 * all of that goes through Sidemates' mediated tools instead. */
export const AMBIENT_DENIED = ["read", "write", "edit", "glob", "grep", "list", "bash", "webfetch", "websearch", "apply_patch", "lsp", "todowrite", "todoread", "task", "question", "skill"];

/** Deny everything, then allow only the named Sidemates tools. Written into
 * each teammate's opencode.json, and checked against the installed runtime by
 * runtime-boundary.ts so a new runtime version cannot silently change what
 * these rules mean. */
export function teammatePermission(allowed: Iterable<string>, reportOnly = false): Record<string, "allow" | "deny"> {
  return reportOnly
    ? { "*": "deny", work_collect: "allow", work_report: "allow" }
    : { "*": "deny", external_directory: "deny", ...Object.fromEntries([...allowed].map((name) => [name, "allow" as const])) };
}
