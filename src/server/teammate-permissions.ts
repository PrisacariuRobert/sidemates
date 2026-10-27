/** The runtime's own file, shell and network tools. They are never enabled:
 * all of that goes through Sidemates' mediated tools instead. */
export const AMBIENT_DENIED = ["read", "write", "edit", "glob", "grep", "list", "bash", "webfetch", "websearch", "apply_patch", "lsp", "todowrite", "todoread", "task", "question", "skill"];

/** The name of the tool server Sidemates adds to OpenCode 2.x. Its tools are
 * called `openbot_<tool>`; the older generation uses the plain name. */
export const TOOL_PREFIX = "openbot_";

/** Both names for each tool, one explicit rule each: never a wildcard, so a tool
 * stays denied until it is listed here. */
const both = (names: Iterable<string>) => Object.fromEntries([...names].flatMap((name) => [[name, "allow" as const], [`${TOOL_PREFIX}${name}`, "allow" as const]]));

/** Deny everything, then allow only the named Sidemates tools. Written into
 * each teammate's opencode.json, and checked against the installed runtime by
 * runtime-boundary.ts so a new runtime version cannot silently change what
 * these rules mean. */
export function teammatePermission(allowed: Iterable<string>, reportOnly = false): Record<string, "allow" | "deny"> {
  return reportOnly
    ? { "*": "deny", ...both(["work_collect", "work_report"]) }
    : { "*": "deny", external_directory: "deny", ...both(allowed) };
}
