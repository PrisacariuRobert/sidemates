import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenBotDatabase } from "./testing/database.js";
import { toolAvailability } from "./tool-availability.js";
import { prepareWorkspace } from "./workspace.js";
import { GOOGLE_SCOPES } from "./google-workspace.js";

test("standard reports expose only source collection and saved results", () => {
  const root = mkdtempSync(path.join(tmpdir(), "openbot-report-tools-"));
  const db = new OpenBotDatabase(root);
  try {
    db.configureGoogleConnector({ clientId: "fixture.apps.googleusercontent.com" });
    db.completeGoogleConnector({ accessToken: "fixture", expiresAt: new Date(Date.now() + 3600_000).toISOString(), scopes: GOOGLE_SCOPES, accountEmail: "fixture@example.test" });
    db.setBotConnectorAccess("nova", { canRead: true, canSend: true });
    const flags = toolAvailability(db, db.getBot("nova")!, true);
    assert.deepEqual(Object.keys(flags).filter((name) => flags[name]).sort(), ["work_collect", "work_report"]);
    assert.equal(flags.gmail_send, false);
    assert.equal(flags.task_plan, false);
    assert.equal(flags.task_progress, false);
    assert.equal(flags.task_verify, false);
    assert.equal(flags.routine_create, false);
    assert.equal(flags.routine_list, false);
    assert.equal(flags.routine_update, false);
    assert.equal(flags.routine_pause, false);
    assert.equal(flags.routine_resume, false);
    assert.equal(flags.routine_delete, false);
    assert.equal(flags.remember, false);
    assert.equal(flags.handoff, false);
    assert.equal(flags.message_teammate, false);
    assert.equal(flags.read, false);
    assert.equal(flags.spreadsheet_export, false);
    assert.equal(flags.spreadsheet_inspect, false);
    assert.equal(flags.table_summary, false);
    const workspace = prepareWorkspace(db, db.getBot("nova")!, true);
    const configuration = JSON.parse(readFileSync(path.join(workspace, "opencode.json"), "utf8"));
    assert.deepEqual(configuration.agent["openbot-report"].permission, { "*": "deny", work_collect: "allow", openbot_work_collect: "allow", work_report: "allow", openbot_work_report: "allow" });
    assert.equal(configuration.tools, undefined);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("keeps irrelevant app schemas out of a file-only task and updates after capability changes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "openbot-tool-context-"));
  const db = new OpenBotDatabase(root);
  try {
    const bot = db.updateBot("nova", {
      browserEnabled: false,
      computerEnabled: false,
    })!;
    const flags = toolAvailability(db, bot);
    for (const name of [
      "gmail_send",
      "gmail_search",
      "slack_read",
      "notion_update",
      "browser_click",
      "bash",
      "code_write",
      "mac_read",
    ])
      assert.equal(flags[name], false, name);
    assert.equal(flags.task_plan, true);
    assert.equal(flags.task_progress, true);
    assert.equal(flags.task_verify, true);
    assert.equal(flags.handoff, true);
    assert.equal(flags.message_teammate, true);
    assert.equal(flags.spreadsheet_export, true);
    assert.equal(flags.spreadsheet_inspect, true);
    assert.equal(flags.table_summary, true);
    const workspace = prepareWorkspace(db, bot);
    const config = JSON.parse(
      readFileSync(path.join(workspace, "opencode.json"), "utf8"),
    );
    assert.equal(config.tools.gmail_search, false);
    for (const name of ["task_plan", "task_progress", "task_verify", "routine_create", "routine_list", "routine_update", "routine_pause", "routine_resume", "routine_delete", "remember", "handoff", "message_teammate"]) {
      assert.equal(config.tools[name], true, `${name} tool is exposed`);
      assert.equal(config.permission[name], "allow", `${name} permission is allowed`);
      assert.equal(config.agent.openbot.permission[name], "allow", `${name} agent permission is allowed`);
    }
    for (const name of ["read", "write", "edit", "bash", "webfetch", "apply_patch"]) {
      assert.equal(config.tools[name], false, `${name} remains unavailable`);
      assert.notEqual(config.permission[name], "allow", `${name} remains denied`);
    }
    assert.match(readFileSync(path.join(workspace, ".opencode/tools/spreadsheet_export.ts"), "utf8"), /numberColumns/);
    db.updateStudioSettings({ macAccessEnabled: true });
    const updated = db.updateBot("nova", { browserEnabled: true })!;
    assert.equal(toolAvailability(db, updated).browser_click, true);
    assert.equal(toolAvailability(db, updated).mac_read, true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("exposes Google creation tools only after both OAuth scope and teammate permission", () => {
  const root = mkdtempSync(path.join(tmpdir(), "openbot-google-tool-context-"));
  const db = new OpenBotDatabase(root);
  try {
    const bot = db.getBot("nova")!;
    db.configureGoogleConnector({ clientId: "desktop-client.apps.googleusercontent.com" });
    db.completeGoogleConnector({ accessToken: "old-access", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/calendar.readonly"], accountEmail: "owner@example.com" });
    db.setBotConnectorAccess(bot.id, { canRead: true, canSend: true }, "google-drive");
    db.setBotConnectorAccess(bot.id, { canRead: true, canSend: true }, "google-calendar");
    assert.equal(toolAvailability(db, bot).google_drive_read, true);
    assert.equal(toolAvailability(db, bot).google_drive_create, false);
    assert.equal(toolAvailability(db, bot).google_calendar_create, false);

    db.completeGoogleConnector({ accessToken: "new-access", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: GOOGLE_SCOPES, accountEmail: "owner@example.com" });
    assert.equal(toolAvailability(db, bot).google_drive_create, false);
    db.setBotConnectorAccess(bot.id, { canRead: true, canSend: true }, "google-drive");
    db.setBotConnectorAccess(bot.id, { canRead: true, canSend: true }, "google-calendar");
    assert.equal(toolAvailability(db, bot).google_drive_create, true);
    assert.equal(toolAvailability(db, bot).google_calendar_create, true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
