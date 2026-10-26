import type { Bot, ConnectorServiceId } from "../shared/types.js";
import type { OpenBotDatabase } from "./database.js";
import { connectorCatalog } from "./google-workspace.js";
import { macFallbackAllowed } from "./mac-productivity.js";
import { McpConnections } from "./mcp-connections.js";
import { CommunitySkills } from "./community-skills.js";
import { webResearchEnabled } from "./web-research.js";
import { findTool, videoToolsAvailable } from "./video-render.js";

// Context reduction only. The tool endpoints remain the authorization boundary
// and recheck grants when a call arrives, including after session revocation.
export function toolAvailability(
  db: OpenBotDatabase,
  bot: Bot,
  reportOnly = false,
): Record<string, boolean> {
  const flags: Record<string, boolean> = {
    task_plan: true,
    task_progress: true,
    task_verify: true,
    routine_create: true,
    routine_list: true,
    routine_update: true,
    routine_pause: true,
    routine_resume: true,
    routine_delete: true,
    remember: true,
    handoff: true,
    message_teammate: true,
    spreadsheet_export: true,
    document_export: true,
    video_render: videoToolsAvailable(),
    video_fetch: bot.browserEnabled && Boolean(findTool("yt-dlp")),
    web_search: bot.browserEnabled && webResearchEnabled(),
    web_read: bot.browserEnabled && webResearchEnabled(),
    spreadsheet_inspect: true,
    table_summary: true,
    table_reconcile: true,
    bash: bot.computerEnabled,
    isolated_bash: bot.computerEnabled,
    connected_tools: new McpConnections(db).toolsFor(bot.id).length > 0,
    connected_call: new McpConnections(db).toolsFor(bot.id).length > 0,
    community_skill_search: new CommunitySkills(db).search(bot.id).length > 0,
    community_skill_read: new CommunitySkills(db).search(bot.id).length > 0,
    memory_search: true,
    conversation_search: true,
    // Teaching and self-extension always pause for the owner's exact review
    // (even in YOLO). They must be listed here: the runtime denies every tool
    // that is not, so /learn silently produced a loose file instead.
    skill_propose: true,
    self_extend: db.getStudioSettings().selfExtendEnabled,
  };
  const set = (names: string[], available: boolean) => {
    for (const name of names) flags[name] = available;
  };
  set(
    ["browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_upload_saved_file", "browser_arm_downloads", "browser_download_results", "browser_request_sign_in"],
    bot.browserEnabled,
  );
  const semanticBrowser = bot.browserEnabled && db.getStudioSettings().semanticBrowserEnabled;
  set(["browser_observe", "browser_semantic_act", "browser_semantic_upload"], semanticBrowser);
  flags.browser_see = semanticBrowser && db.providerForBot(bot.id)?.runtime === "opencode";
  if (semanticBrowser) set(["browser_snapshot", "browser_click", "browser_type", "browser_upload_saved_file"], false);
  set(
    [
      "mac_list",
      "mac_read",
      "mac_organize",
      "mac_apps_list",
      "mac_app_inspect",
      "mac_app_read",
      "mac_app_open",
      "mac_app_click",
      "mac_app_type",
      "mac_app_key",
      "mac_app_scroll",
    ],
    db.getStudioSettings().macAccessEnabled,
  );
  // Apple app tools run fixed scripts against Reminders, Notes, Calendar…:
  // only on a Mac.
  set(
    ["mac_calendar_events", "mac_mail_unread", "mac_mail_search", "mac_mail_read", "mac_mail_save_attachment", "mac_reminders", "mac_reminder_create", "mac_notes_search", "mac_note_read", "mac_note_create", "mac_contacts_find", "mac_calendars", "mac_event_create", "mac_mail_draft", "queue_propose", "mac_shortcuts_list", "mac_shortcut_run"],
    db.getStudioSettings().macAccessEnabled && process.platform === "darwin",
  );
  // The personal index is searchable once the owner has switched a source on.
  flags.search_my_mac = db.getStudioSettings().macAccessEnabled && process.platform === "darwin" && Object.values(db.extensionRecord<{ enabled?: Record<string, boolean> }>("personal-index", "config")?.enabled || {}).some(Boolean);
  const apps: {
    id: string;
    service: ConnectorServiceId;
    read: string[];
    write: string[];
  }[] = [
    {
      id: "google-workspace",
      service: "gmail",
      read: ["gmail_search", "gmail_read"],
      write: ["gmail_send"],
    },
    {
      id: "google-workspace",
      service: "google-drive",
      read: ["google_drive_search", "google_drive_read"],
      write: ["google_drive_create"],
    },
    {
      id: "google-workspace",
      service: "google-calendar",
      read: ["google_calendar_agenda"],
      write: ["google_calendar_create"],
    },
    {
      id: "github-cli",
      service: "github",
      read: ["github_notifications", "github_issues"],
      write: ["github_issue_create"],
    },
    {
      id: "slack",
      service: "slack",
      read: ["slack_search", "slack_read"],
      write: ["slack_post"],
    },
    {
      id: "notion",
      service: "notion",
      read: ["notion_search", "notion_read"],
      write: ["notion_update"],
    },
    {
      id: "todoist",
      service: "todoist",
      read: ["todoist_tasks"],
      write: ["todoist_task_create", "todoist_task_update", "todoist_task_complete"],
    },
    {
      id: "dropbox",
      service: "dropbox",
      read: ["dropbox_search", "dropbox_read"],
      write: [],
    },
  ];
  const googleConnection = db.getConnector("google-workspace");
  const googleCatalog = connectorCatalog(Boolean(googleConnection?.connected), googleConnection?.scopes || []);
  for (const app of apps) {
    const access = db.getBotConnectorAccess(bot.id, app.service, app.id);
    const google = app.id === "google-workspace" ? googleCatalog.find((entry) => entry.id === app.service) : undefined;
    const readConnected = google ? google.connected : Boolean(db.getConnector(app.id)?.connected);
    const writeConnected = google ? google.writeConnected === true : readConnected;
    set(app.read, readConnected && Boolean(access?.canRead));
    set(app.write, writeConnected && Boolean(access?.canSend));
  }
  set(["gmail_reply"], Boolean(flags.gmail_read && flags.gmail_send));
  const selectedWorkSource = db.getWorkSources(bot.id).selections.some(({ service }) => db.getConnector(service)?.connected && db.getBotConnectorAccess(bot.id, service, service)?.canRead && db.getWorkSources(bot.id).connectionVersions[service] === db.connectorAuthorizationVersion(service));
  set(["work_collect", "work_report"], Boolean(selectedWorkSource || flags.gmail_read || flags.google_calendar_agenda || macFallbackAllowed(db, bot.id, "gmail") || macFallbackAllowed(db, bot.id, "google-calendar")));
  const projects = db.listCodeProjects(bot.id);
  set(
    ["code_list", "code_search", "code_read", "code_status", "code_diff"],
    projects.length > 0,
  );
  set(
    [
      "code_write",
      "code_replace",
      "code_branch",
      "code_commit",
      "code_request_review",
      "code_publish_pr",
    ],
    projects.some((project) =>
      project.access.some(
        (access) => access.botId === bot.id && access.canWrite,
      ),
    ),
  );
  set(
    ["code_run", "code_benchmark"],
    projects.some((project) =>
      project.access.some((access) => access.botId === bot.id && access.canRun),
    ),
  );
  if (reportOnly) {
    const names = [...Object.keys(flags), "workspace_list", "workspace_read", "workspace_write", "workspace_replace", "code_projects", "code_review_result", "task_plan", "task_progress", "task_verify", "skill_propose", "routine_create", "remember", "handoff", "message_teammate", "request_approval", "self_extend", "read", "write", "edit", "glob", "grep", "list", "task", "todowrite", "todoread", "webfetch", "websearch", "question", "skill", "apply_patch", "lsp"];
    return { ...Object.fromEntries(names.map((name) => [name, false])), work_collect: flags.work_collect, work_report: flags.work_report };
  }
  return flags;
}
