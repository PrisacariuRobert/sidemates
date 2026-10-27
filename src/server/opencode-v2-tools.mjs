// Gives an OpenCode 2.x server Sidemates' tools. 2.x does not load the tool
// files 1.x did; its way in is an MCP server, so Sidemates' own tool server
// (the one Claude teammates use) is added to the running server.
//
// `codemode` off puts each tool in front of the model by its own name
// (openbot_workspace_list) instead of behind a code-running "execute" tool, so
// no model-written code runs. Which tools a teammate may call is still decided
// by the deny-by-default rules in the workspace's opencode.json.
//
// A fresh server has not read the folder's settings yet: until it has, the
// teammate's agent does not exist and every rule reads as "deny". A run that
// starts before the tool server is connected, or while the owner's own MCP
// connections (Linear, Figma...) are still starting, gets no tools at all and
// writes its tool calls out as plain text. So: wait for the agent, drop every
// connection that is not Sidemates' own (a teammate never touches the owner's
// personal accounts, and the deny-by-default rules would hide them anyway), add
// ours, and wait until nothing is still starting.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_SERVER = "openbot";
export const toolServerPath = join(dirname(fileURLToPath(import.meta.url)), "claude-mcp.mjs");

/** `call(path, body, method)` talks to the server and returns its JSON. */
export async function connectTools(call, directory, { agent = "openbot", command = [process.execPath, toolServerPath], waitMs = Number(process.env.OPENBOT_TOOL_WAIT_MS) || 25_000, stopped = () => false } = {}) {
  const location = `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
  const settingsUntil = Date.now() + waitMs;
  for (;;) {
    // Asking for anything in the folder makes the server start reading its settings.
    const agents = await call(`/api/agent?${location}`, undefined, "GET");
    if (agents?.data?.some((entry) => entry.id === agent)) break;
    if (Date.now() > settingsUntil || stopped()) throw new Error("OpenCode did not load the teammate's settings.");
    await new Promise((wake) => setTimeout(wake, 250));
  }
  await call(`/api/experimental/mcp/${TOOL_SERVER}?${location}`, { config: { type: "local", command, codemode: false } }, "PUT");
  const until = Date.now() + waitMs;
  const removed = new Set();
  while (Date.now() < until && !stopped()) {
    const listed = (await call(`/api/mcp?${location}`, undefined, "GET"))?.data || [];
    for (const other of listed) {
      if (other.name === TOOL_SERVER || removed.has(other.name)) continue;
      removed.add(other.name);
      await call(`/api/experimental/mcp/${encodeURIComponent(other.name)}?${location}`, undefined, "DELETE").catch(() => {});
    }
    const status = listed.find((server) => server.name === TOOL_SERVER)?.status?.status || "";
    if (status === "failed") break;
    // Ours is up and nothing else is still starting (or left over).
    if (status === "connected" && listed.every((server) => server.name === TOOL_SERVER || removed.has(server.name) && server.status?.status !== "pending")) return;
    await new Promise((wake) => setTimeout(wake, 250));
  }
  throw new Error("Sidemates' tools could not be started for this OpenCode run.");
}
