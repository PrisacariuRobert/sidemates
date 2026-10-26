import { DatabaseSync } from "node:sqlite";
import { defaultConversation } from "../shared/default-conversation.js";
import { fixFor } from "../shared/recovery.js";
import { TASK_TOKEN_TOP_UP, taskTokenAmountSchema, taskTokenRequestSchema, type TaskTokenPolicy, type TaskTokenReview } from "../shared/task-token-budget.js";
import type { ExecutionLimits } from "./execution-policy.js";
import { BUNDLED_ACCESS_KIND, bundledSkillsRevision } from "./bundled-skills.js";
import { rankMemories, nearDuplicateNote, rankTexts } from "./memory-retrieval.js";
import type { AutoReviewRule } from "./auto-review.js";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { workSourcesInput, type WorkSourcesSettings } from "../shared/work-sources.js";
import { memoryKeyIdentity, type PrivateMemory } from "../shared/private-memory.js";
import { apiRuntimeEnvironment, providerInput, isLocalModelUrl, modelBelongsToConnection, MODEL_KEY_ENV, type ProviderInput } from "../shared/provider-config.js";
import type {
  Activity,
  AgentMessage,
  AgentMessageKind,
  AppState,
  Approval,
  ApprovedActionReceipt,
  Attachment,
  ArtifactSummary,
  AutomationAlert,
  RunReceipt,
  RunReceiptCheck,
  RunReceiptEntry,
  Delegation,
  AutomationEvent,
  AutomationEventStatus,
  AutomationTriggerType,
  Bot,
  BotConnectorAccess,
  CodeProject,
  CodeProjectAccess,
  CodeProjectEdit,
  CodeTaskReview,
  CodeTaskWorkspace,
  ConnectorConnection,
  ConnectorEvent,
  ConnectorServiceId,
  GoogleConnectorService,
  MascotKind,
  Message,
  ProviderInstance,
  Routine,
  RoutineTriggerConfig,
  RunnerHealth,
  Run,
  RunStatus,
  SkillVersion,
  StudioSettings,
  StudioSearchResult,
  StudioDraft,
  TaskContract,
  TaskStage,
  TaskStep,
  TaskStepStatus,
  TaskVerificationCheck,
  TaskVerificationStatus,
  TaughtWorkflow,
  Thread,
  TodoistTaskSummary,
  UsageSummary,
} from "../shared/types.js";
import { SecretVault } from "./vault.js";
import { legacyCadence, normalizeRoutineInterval } from "../shared/routines.js";
import { replyEscalatesToOwner } from "../shared/routing.js";
import { intervalSchedule, nextRoutineOccurrence, routineScheduleInput, scheduleLabel, type RoutineSchedule } from "../shared/calendar-schedule.js";
import { skillSlug } from "../shared/skills.js";
import type { AttachmentAnalysis } from "./attachments.js";
import { attachmentClassification } from "./attachments.js";
import type { WorkSnapshot, WorkReport } from "../shared/work-reports.js";
import type { CodeCheckReceipt } from "../shared/code-checks.js";
import { automationRepairHint, normalizedTriggerConfig } from "./automations.js";
import { WorkflowValidation } from "./workflow-validation.js";

type Row = Record<string, string | number | null>;
const now = () => new Date().toISOString();
const DEFAULT_OWNER = "local-owner";
/** A week's use as the counters show it: fresh tokens in full (including
 * input a provider stores to re-read later), and cached re-reading at a
 * tenth, the way AI providers price it. Per-task allowances stay on fresh
 * input and output, so jobs don't stop sooner. */
const WEEKLY_TOKENS_SQL = "input_tokens+output_tokens+reasoning_tokens+cache_write_tokens+cache_read_tokens/10";
const PUBLIC_OAUTH_CLIENT = "__OPENBOT_PUBLIC_OAUTH_CLIENT__";

function asBoolean(value: string | number | null | undefined): boolean {
  return value === 1 || value === "1";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

function jsonArray<T>(value: string | number | null | undefined): T[] {
  if (typeof value !== "string" || !value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed as T[] : []; }
  catch { return []; }
}

function jsonRecord(value: string | number | null | undefined): Record<string, string | number | boolean> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string | number | boolean> : {};
  } catch { return {}; }
}

/** Canonical payload digest for POST /api/messages idempotency (P01).
 * Binds every semantic input: thread, final text, attachment IDs in order
 * (order is meaningful), reply target, explicitly selected teammates
 * (sorted — order is not meaningful), time zone and expected work kind.
 * Same requestId + different digest is a conflict, never a silent reuse. */
export function messageSubmissionDigest(input: {
  threadId: string; body: string; attachmentIds: string[];
  replyToId?: string | null; targetBotIds?: string[];
  timeZone?: string; expectedWorkKind?: string;
}): string {
  const canonical = {
    threadId: input.threadId,
    body: input.body,
    attachmentIds: [...input.attachmentIds],
    replyToId: input.replyToId ?? null,
    targetBotIds: [...(input.targetBotIds ?? [])].sort(),
    timeZone: input.timeZone ?? null,
    expectedWorkKind: input.expectedWorkKind ?? null,
  };
  return createHash("sha256").update(stableJson(canonical)).digest("hex");
}

export type MessageSubmissionReceipt = {
  requestId: string;
  threadId: string;
  payloadDigest: string;
  messageId: string | null;
  runIds: string[];
  routineIds: string[];
  routedTo: Array<{ id: string; name: string }>;
  attachmentIds: string[];
  responseStatus: number;
  createdAt: string;
};

/** One card in the "Waiting for you" queue: a typed, reviewable proposal
 * that a person approves, skips or undoes. Cards never run on their own. */
export type QueueItemStatus = "ready" | "done" | "skipped" | "undone" | "failed" | "expired";
export type QueueItemRecord = {
  id: string;
  kind: string;
  status: QueueItemStatus;
  title: string;
  why: string;
  sourceKey: string;
  botId: string | null;
  runId: string | null;
  action: Record<string, unknown>;
  preview: string;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  undoneAt: string | null;
  /** The narrow kind of thing this card is ("reminder|billing@acme.com|Bills"), or null when it can never be automatic. */
  pattern: string | null;
  /** Receipt details for a filed attachment (vendor, amount, currency, date, reference), checked against the email; otherwise null. */
  meta: Record<string, string> | null;
};

/** A person's standing "yes" to one narrow pattern. Active rules run matching cards by themselves;
 * paused ones wait for the person; declined ones are never offered again. */
export type QueueRuleStatus = "active" | "paused" | "declined";
export type QueueRuleRecord = {
  id: string;
  kind: string;
  pattern: string;
  status: QueueRuleStatus;
  pausedReason: string | null;
  uses: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

/** One durable action-journal row (R02). Renderer-independent companion to
 * approved_actions: DOM, visual and native dispatches admit here first. */
export type ActionJournalRecord = {
  actionId: string;
  runId: string;
  botId: string;
  surface: string;
  surfaceIdentity: string;
  ownershipEpoch: string;
  target: string;
  payloadDigest: string;
  reviewDigest: string | null;
  account: string;
  /** Host-owned logical mutation identity (Finding A): the accountable
   * outer layer assigns one key per unit of intended effect. The fence
   * survives re-observation, renderer switches and restarts; distinct
   * genuinely-new work uses distinct keys. Null when the caller declares
   * no logical identity (legacy direct calls). */
  mutationKey: string | null;
  /** Canonical logical-effect digest (Finding G1): kind, target identity,
   * final value and run/bot scope — stable across re-observation and
   * renderer switches for the same intent, different for different work. */
  effectDigest: string | null;
  stage:
    | "proposed"
    | "validated"
    | "awaiting_review"
    | "admitted"
    | "dispatch_started"
    | "effect_observed"
    | "verified"
    | "failed_before_effect"
    | "outcome_uncertain";
  detail: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A routine mutation lost a revision race (P03b). The caller must re-list
 * and confirm against currentRevision instead of overwriting it. */
export class RoutineRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`That routine changed while you were looking at it (now revision ${currentRevision}). List it again and confirm the change on the current schedule.`);
  }
}
export type ConnectorTaskRef = {
  connectorId: string;
  resourceId: string;
  account: string;
  authorizationVersion: number;
  threadId: string;
  runId: string;
  botId: string;
  reviewedFields: Record<string, string | number | boolean>;
  lastState: TodoistTaskSummary;
  createdAt: string;
  updatedAt: string;
};

/** A deleted routine's durable receipt (P03c). The row itself is gone, but
 * what it was, which revision died, and which run deleted it is recorded —
 * so history stays attributable and an old retry can never resurrect it.
 * Past runs and events keep their routine id and stay readable as orphans. */
export type DeletedRoutineReceipt = {
  routineId: string;
  name: string;
  botId: string;
  threadId: string;
  triggerType: string;
  revisionAtDelete: number;
  deletedByRunId: string | null;
  createdAt: string;
};

function taskGoal(prompt: string): string {
  return prompt.split("\n\nFiles attached by the user")[0]!.replace(/^(?:Handoff|Private teammate message) from [^:]+:\s*/i, "").replace(/\s+/g, " ").trim().slice(0, 240) || "Finish the requested work";
}

function shouldTrackTask(prompt: string, relatedRun: boolean): boolean {
  if (relatedRun) return true;
  const text = taskGoal(prompt).toLowerCase();
  if (text.length >= 64) return true;
  return /\b(?:make|create|build|write|draft|prepare|organize|clean|fix|change|update|research|find|search|review|check|verify|test|summari[sz]e|compare|read|open|send|schedule|plan|investigate|email|inbox|calendar|drive|desktop|file|folder|browser|website|report|brief)\b/.test(text);
}

function startingTaskSteps(): TaskStep[] {
  return [
    { id: 1, title: "Understand the outcome", status: "pending", detail: null },
    { id: 2, title: "Complete the work", status: "pending", detail: null },
    { id: 3, title: "Check and deliver the result", status: "pending", detail: null },
  ];
}

/** "Click “Book” on example.com" → "Clicked “Book” on example.com": the
 * chat receipt says what happened, not the page's full title. */
export function doneLabel(actionLabel: string | null | undefined): string {
  const label = (actionLabel || "").trim();
  if (!label) return "";
  const past: Array<[RegExp, string]> = [[/^Click\b/, "Clicked"], [/^Type\b/, "Typed"], [/^Open\b/, "Opened"], [/^Send\b/, "Sent"], [/^Upload\b/, "Uploaded"], [/^Create\b/, "Created"], [/^Post\b/, "Posted"], [/^Reply\b/, "Replied"], [/^Save\b/, "Saved"]];
  for (const [pattern, word] of past) if (pattern.test(label)) return `${label.replace(pattern, word)}.`.replace(/\.\.$/, ".");
  return `Done: ${label}`;
}

export class OpenBotDatabase {
  readonly rootDir: string;
  readonly dataDir: string;
  readonly workspacesDir: string;
  readonly computersDir: string;
  readonly attachmentsDir: string;
  readonly vault: SecretVault;
  private readonly db: DatabaseSync;
  private readonly runStatusListeners = new Set<(runId: string, status: RunStatus) => void>();

  constructor(rootDir: string, options: { dataDir?: string; seedStarterBots?: boolean } = {}) {
    this.rootDir = rootDir;
    if (options.dataDir && !path.isAbsolute(options.dataDir)) throw new Error("An isolated data directory must be absolute.");
    this.dataDir = options.dataDir || process.env.OPENBOT_DATA_DIR || path.join(rootDir, ".openbot");
    // Validate a restored studio's encryption identity before creating folders
    // or opening/migrating its database. A missing key must cause zero writes.
    this.vault = new SecretVault(this.dataDir);
    this.workspacesDir = path.join(this.dataDir, "workspaces");
    this.computersDir = path.join(this.dataDir, "computers");
    this.attachmentsDir = path.join(this.dataDir, "attachments");
    mkdirSync(this.workspacesDir, { recursive: true });
    mkdirSync(this.computersDir, { recursive: true });
    mkdirSync(this.attachmentsDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDir, "openbot.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.seed(options.seedStarterBots === true);
  }

  close() {
    this.db.close();
  }

  onRunStatusChange(listener: (runId: string, status: RunStatus) => void) {
    this.runStatusListeners.add(listener);
    return () => this.runStatusListeners.delete(listener);
  }

  extensionRecords<T>(kind: string): Array<{ id: string; value: T }> {
    return (this.db.prepare("SELECT id,payload FROM extension_records WHERE kind=? ORDER BY id").all(kind) as Row[])
      .map((row) => ({ id: String(row.id), value: JSON.parse(this.vault.decrypt(String(row.payload))) as T }));
  }

  extensionRecord<T>(kind: string, id: string): T | null {
    const row = this.db.prepare("SELECT payload FROM extension_records WHERE kind=? AND id=?").get(kind, id) as Row | undefined;
    return row ? JSON.parse(this.vault.decrypt(String(row.payload))) as T : null;
  }

  saveExtensionRecord(kind: string, id: string, value: unknown) {
    this.db.prepare("INSERT INTO extension_records(kind,id,payload) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload")
      .run(kind, id, this.vault.encrypt(JSON.stringify(value)));
  }

  /** Persist the verified remote result and owner notification atomically.
   * Neither depends on a subsequent model response or its final run status. */
  recordCodeDeliveryResult(receipt: import("./code-delivery.js").CodeDeliveryReceipt): { receipt: import("./code-delivery.js").CodeDeliveryReceipt; message: Message } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.getRun(receipt.runId);
      if (!run || run.botId !== receipt.botId) throw new Error("The code delivery does not belong to this task.");
      const existing = this.extensionRecord<import("./code-delivery.js").CodeDeliveryReceipt>("code-delivery", receipt.runId);
      const notification = this.extensionRecord<{ messageId: string }>("code-delivery-notification", receipt.runId);
      if (existing) {
        const message = notification ? this.getMessage(notification.messageId) : null;
        if (existing.url !== receipt.url || existing.headCommit !== receipt.headCommit || existing.projectId !== receipt.projectId || existing.botId !== receipt.botId || !message || message.threadId !== run.threadId) throw new Error("This task already has a different or incomplete delivery record.");
        this.db.exec("COMMIT");
        return { receipt: existing, message };
      }
      this.saveExtensionRecord("code-delivery", receipt.runId, receipt);
      const message = this.addMessage({
        threadId: run.threadId, senderType: "system", senderId: null,
        body: `Your ${receipt.draft ? "draft pull request" : "pull request"} is ready for review.\n\n[View the change](${receipt.url})\n\nChecked version \`${receipt.headCommit.slice(0, 12)}\`. Sidemates did not merge or deploy it; repository automations may run.`,
      });
      this.saveExtensionRecord("code-delivery-notification", receipt.runId, { messageId: message.id });
      this.db.exec("COMMIT");
      return { receipt, message };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  deleteExtensionRecord(kind: string, id: string) {
    this.db.prepare("DELETE FROM extension_records WHERE kind=? AND id=?").run(kind, id);
  }

  markApprovedActionUncertain(approvalId: string, message: string) {
    this.db.prepare("UPDATE approved_actions SET status='uncertain',last_error=?,finished_at=? WHERE approval_id=? AND status='running'")
      .run(message.slice(0, 1_000), now(), approvalId);
  }

  countAppReadReceipts(runId: string) {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM app_read_receipts WHERE run_id=?").get(runId) as Row).count);
  }

  saveAppReadReceipt(receipt: import("./mac-app-read.js").AppReadReceipt) {
    this.db.prepare("INSERT INTO app_read_receipts (id,run_id,receipt_encrypted) VALUES (?,?,?)").run(receipt.id,receipt.runId,this.vault.encrypt(JSON.stringify(receipt)));
  }

  getAppReadReceipt(id: string): import("./mac-app-read.js").AppReadReceipt | null {
    const row=this.db.prepare("SELECT receipt_encrypted FROM app_read_receipts WHERE id=?").get(id) as Row | undefined;
    return row ? JSON.parse(this.vault.decrypt(String(row.receipt_encrypted))) : null;
  }

  saveWorkSnapshot(snapshot: WorkSnapshot) {
    this.db.prepare("INSERT INTO work_snapshots (id, run_id, created_at, snapshot_encrypted) VALUES (?, ?, ?, ?)")
      .run(snapshot.id, snapshot.runId, snapshot.fetchedAt, this.vault.encrypt(JSON.stringify(snapshot)));
  }

  recentWorkSnapshots(): WorkSnapshot[] {
    return (this.db.prepare("SELECT snapshot_encrypted FROM work_snapshots WHERE report_encrypted IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 10").all() as Row[])
      .map((row) => JSON.parse(this.vault.decrypt(String(row.snapshot_encrypted))) as WorkSnapshot);
  }

  getWorkSnapshot(id: string): WorkSnapshot | null {
    const row = this.db.prepare("SELECT snapshot_encrypted FROM work_snapshots WHERE id=?").get(id) as Row | undefined;
    return row ? JSON.parse(this.vault.decrypt(String(row.snapshot_encrypted))) as WorkSnapshot : null;
  }

  listWorkSnapshots(runId: string): WorkSnapshot[] {
    return (this.db.prepare("SELECT snapshot_encrypted FROM work_snapshots WHERE run_id=? ORDER BY created_at DESC, rowid DESC LIMIT 3").all(runId) as Row[])
      .map((row) => JSON.parse(this.vault.decrypt(String(row.snapshot_encrypted))) as WorkSnapshot);
  }

  getWorkReport(snapshotId: string): WorkReport | null {
    const row = this.db.prepare("SELECT report_encrypted FROM work_snapshots WHERE id=?").get(snapshotId) as Row | undefined;
    return row?.report_encrypted ? JSON.parse(this.vault.decrypt(String(row.report_encrypted))) as WorkReport : null;
  }

  saveWorkReport(report: WorkReport) {
    // A retry cannot silently replace a result already delivered.
    const result = this.db.prepare("UPDATE work_snapshots SET report_encrypted=? WHERE id=? AND report_encrypted IS NULL")
      .run(this.vault.encrypt(JSON.stringify(report)), report.snapshotId);
    if (result.changes !== 1) throw new Error("That result is already saved or its source snapshot is missing.");
  }

  saveCodeCheck(receipt: CodeCheckReceipt) {
    this.db.prepare("INSERT INTO code_check_receipts (id, run_id, receipt_encrypted) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET receipt_encrypted=excluded.receipt_encrypted")
      .run(receipt.id, receipt.runId, this.vault.encrypt(JSON.stringify(receipt)));
  }

  listCodeChecks(runId: string): CodeCheckReceipt[] {
    return (this.db.prepare("SELECT receipt_encrypted FROM code_check_receipts WHERE run_id=? ORDER BY rowid DESC LIMIT 100").all(runId) as Row[])
      .map((row) => JSON.parse(this.vault.decrypt(String(row.receipt_encrypted))) as CodeCheckReceipt);
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    return rows.some((row) => row.name === column);
  }

  private addColumn(table: string, definition: string) {
    const name = definition.trim().split(/\s+/)[0]!;
    if (!this.hasColumn(table, name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }

  private migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS extension_records (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id))");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_instances (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        auth_mode TEXT NOT NULL,
        runtime TEXT NOT NULL DEFAULT 'opencode',
        env_name TEXT,
        secret_ciphertext TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connectors (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        client_id TEXT,
        client_secret_ciphertext TEXT,
        access_token_ciphertext TEXT,
        refresh_token_ciphertext TEXT,
        credentials_ciphertext TEXT,
        event_path_ciphertext TEXT,
        event_secret_ciphertext TEXT,
        event_verified_at TEXT,
        token_expires_at TEXT,
        scopes_json TEXT NOT NULL DEFAULT '[]',
        account_email TEXT,
        status TEXT NOT NULL DEFAULT 'unconfigured',
        last_error TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_sessions (
        session_id TEXT PRIMARY KEY,
        capability_fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_source_settings (
        bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 1,
        settings_encrypted TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connector_service_errors (
        connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
        service TEXT NOT NULL,
        last_error TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_id, service)
      );
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        color TEXT NOT NULL,
        role TEXT NOT NULL,
        instructions TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_active_at TEXT,
        owner_id TEXT,
        provider_instance_id TEXT,
        mascot TEXT NOT NULL DEFAULT 'orbit',
        computer_enabled INTEGER NOT NULL DEFAULT 1,
        browser_enabled INTEGER NOT NULL DEFAULT 1,
        mac_access_enabled INTEGER NOT NULL DEFAULT 0,
        weekly_token_budget INTEGER NOT NULL DEFAULT 2000000
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('direct', 'room')),
        bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
        section_name TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_bots (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        PRIMARY KEY(thread_id, bot_id)
      );
      CREATE TABLE IF NOT EXISTS thread_drafts (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        body TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        sender_type TEXT NOT NULL CHECK(sender_type IN ('user', 'bot', 'system')),
        sender_id TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        run_id TEXT,
        reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(message_id, emoji, actor)
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        detected_mime TEXT NOT NULL DEFAULT 'application/octet-stream',
        kind TEXT NOT NULL DEFAULT 'file',
        processing_status TEXT NOT NULL DEFAULT 'ready',
        summary TEXT,
        extracted_text TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        previewable INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'upload',
        artifact_key TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        replaces_attachment_id TEXT,
        size INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS draft_attachments (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(thread_id, attachment_id)
      );
      CREATE TABLE IF NOT EXISTS bot_saved_files (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(bot_id, attachment_id)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_reason TEXT,
        started_at TEXT,
        finished_at TEXT,
        summary TEXT,
        error TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL,
        approval_id TEXT,
        partial_text TEXT,
        progress_at TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        parent_run_id TEXT,
        steered_from_run_id TEXT,
        routine_id TEXT,
        automation_event_id TEXT,
        consultation_pending INTEGER NOT NULL DEFAULT 0,
        attachment_ids_json TEXT NOT NULL DEFAULT '[]',
        task_goal TEXT,
        task_deliverable TEXT,
        task_approval_boundary TEXT,
        task_required_apps_json TEXT NOT NULL DEFAULT '[]',
        task_stage TEXT NOT NULL DEFAULT 'queued',
        task_steps_json TEXT NOT NULL DEFAULT '[]',
        verification_status TEXT NOT NULL DEFAULT 'pending',
        verification_summary TEXT,
        verification_checks_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS courier_messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        read_at TEXT
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        action_label TEXT NOT NULL,
        action_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS approved_actions (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        action_type TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'prepared',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        reviewed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS action_journal (
        action_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        surface TEXT NOT NULL,
        surface_identity TEXT NOT NULL,
        ownership_epoch TEXT NOT NULL,
        target TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        review_digest TEXT,
        account TEXT NOT NULL DEFAULT '',
        stage TEXT NOT NULL DEFAULT 'proposed',
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS action_journal_run_stage ON action_journal(run_id, stage);
      CREATE TABLE IF NOT EXISTS queue_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        title TEXT NOT NULL,
        why TEXT NOT NULL,
        source_key TEXT NOT NULL,
        bot_id TEXT,
        run_id TEXT,
        action_json TEXT NOT NULL,
        preview TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        undone_at TEXT,
        pattern TEXT,
        meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS queue_items_status ON queue_items(status, created_at);
      CREATE TABLE IF NOT EXISTS queue_rules (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        pattern TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','declined')),
        paused_reason TEXT,
        uses INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS queue_items_active_source ON queue_items(kind, source_key) WHERE status IN ('ready','done');
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        cadence TEXT NOT NULL CHECK(cadence IN ('hourly', 'daily')),
        interval_minutes INTEGER NOT NULL DEFAULT 1440,
        trigger_type TEXT NOT NULL DEFAULT 'schedule',
        trigger_config_json TEXT NOT NULL DEFAULT '{}',
        webhook_secret_ciphertext TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        next_run_at TEXT,
        last_run_at TEXT,
        last_status TEXT NOT NULL DEFAULT 'never',
        run_count INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        deduplicated_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        paused_reason TEXT,
        last_success_at TEXT,
        last_event_at TEXT
      );
      CREATE TABLE IF NOT EXISTS automation_events (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        routine_name TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        replay_of_event_id TEXT,
        payload_summary TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        received_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT,
        attempt INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS automation_events_routine_time ON automation_events(routine_id,received_at DESC);
      CREATE INDEX IF NOT EXISTS automation_events_dedupe ON automation_events(routine_id,dedupe_key,received_at DESC);
      CREATE TABLE IF NOT EXISTS automation_alerts (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        routine_name TEXT NOT NULL,
        run_id TEXT,
        event_id TEXT,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS automation_cursors (
        routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(routine_id,source)
      );
      CREATE TABLE IF NOT EXISTS runner_state (
        id TEXT PRIMARY KEY CHECK(id='primary'),
        instance_id TEXT,
        mode TEXT NOT NULL DEFAULT 'foreground',
        started_at TEXT,
        heartbeat_at TEXT,
        lease_expires_at TEXT,
        last_cycle_at TEXT,
        recovered_runs INTEGER NOT NULL DEFAULT 0,
        dispatched_runs INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_success_at TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS native_push_devices (
        id TEXT PRIMARY KEY,
        device_token TEXT NOT NULL UNIQUE,
        environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
        bundle_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_success_at TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        notification_id TEXT NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK(channel IN ('web','apns')),
        target_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(notification_id,channel,target_id)
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        memory_key TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(bot_id, memory_key)
      );
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        memory_key TEXT NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        text TEXT NOT NULL,
        vector TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, memory_key)
      );
      CREATE TABLE IF NOT EXISTS auto_review_rules (
        id TEXT PRIMARY KEY,
        effect TEXT NOT NULL CHECK(effect IN ('always_allow','require_approval')),
        scope TEXT NOT NULL CHECK(scope IN ('command','prompt','browser')),
        pattern TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS taught_workflows (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        start_url TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        skill_path TEXT NOT NULL,
        skill_slug TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL DEFAULT 'taught',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_versions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES taught_workflows(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        start_url TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(workflow_id, version)
      );
      CREATE TABLE IF NOT EXISTS dedupe_keys (
        dedupe_key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        from_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        to_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        kind TEXT NOT NULL,
        expects_reply INTEGER NOT NULL DEFAULT 0,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        reply_to_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
        hop_count INTEGER NOT NULL DEFAULT 0,
        dedupe_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_submissions (
        request_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        payload_digest TEXT NOT NULL,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        run_ids_json TEXT NOT NULL DEFAULT '[]',
        routine_ids_json TEXT NOT NULL DEFAULT '[]',
        routed_to_json TEXT NOT NULL DEFAULT '[]',
        attachment_ids_json TEXT NOT NULL DEFAULT '[]',
        response_status INTEGER NOT NULL DEFAULT 202,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_submissions_thread_time ON message_submissions(thread_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS connector_task_refs (
        connector_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        account TEXT NOT NULL DEFAULT '',
        authorization_version INTEGER NOT NULL DEFAULT 0,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        reviewed_fields_json TEXT NOT NULL DEFAULT '{}',
        last_state_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_id, resource_id)
      );
      CREATE INDEX IF NOT EXISTS connector_task_refs_thread_time ON connector_task_refs(thread_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS deleted_routine_receipts (
        routine_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL DEFAULT 'schedule',
        revision_at_delete INTEGER NOT NULL DEFAULT 1,
        deleted_by_run_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_connector_access (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
        service TEXT NOT NULL,
        can_read INTEGER NOT NULL DEFAULT 0,
        can_send INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(bot_id, connector_id, service)
      );
      CREATE TABLE IF NOT EXISTS connector_events (
        id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
        bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS code_projects (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        git_repository INTEGER NOT NULL DEFAULT 0,
        project_kind TEXT NOT NULL DEFAULT 'Code project',
        remote_url TEXT,
        default_branch TEXT,
        managed_clone INTEGER NOT NULL DEFAULT 0,
        connected INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_project_access (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES code_projects(id) ON DELETE CASCADE,
        can_read INTEGER NOT NULL DEFAULT 0,
        can_write INTEGER NOT NULL DEFAULT 0,
        can_run INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(bot_id, project_id)
      );
      CREATE TABLE IF NOT EXISTS code_project_edits (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES code_projects(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        operation TEXT NOT NULL,
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        before_content TEXT,
        after_hash TEXT,
        workspace_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        restored_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS code_task_workspaces (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES code_projects(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        branch TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS code_task_reviews (
        id TEXT PRIMARY KEY,
        source_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        reviewer_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES code_projects(id) ON DELETE CASCADE,
        reviewer_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        verdict TEXT NOT NULL,
        summary TEXT NOT NULL,
        findings_json TEXT NOT NULL DEFAULT '[]',
        head_commit TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS code_check_receipts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        receipt_encrypted TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS code_check_receipts_run ON code_check_receipts(run_id);
      CREATE TABLE IF NOT EXISTS app_read_receipts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        receipt_encrypted TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS app_read_receipts_run ON app_read_receipts(run_id);
      CREATE TABLE IF NOT EXISTS work_snapshots (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        snapshot_encrypted TEXT NOT NULL,
        report_encrypted TEXT
      );
      CREATE INDEX IF NOT EXISTS work_snapshots_run ON work_snapshots(run_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_thread_created ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS message_reactions_message ON message_reactions(message_id, created_at);
      CREATE INDEX IF NOT EXISTS attachments_message_created ON attachments(message_id, created_at);
      CREATE INDEX IF NOT EXISTS runs_status_created ON runs(status, created_at);
      CREATE INDEX IF NOT EXISTS runs_bot_created ON runs(bot_id, created_at);
      CREATE INDEX IF NOT EXISTS approvals_status_created ON approvals(status, created_at);
      CREATE INDEX IF NOT EXISTS approved_actions_status_created ON approved_actions(status, created_at);
      CREATE INDEX IF NOT EXISTS agent_messages_thread_created ON agent_messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS agent_messages_to_created ON agent_messages(to_bot_id, created_at);
      CREATE INDEX IF NOT EXISTS connector_events_created ON connector_events(connector_id, created_at);
      CREATE INDEX IF NOT EXISTS code_project_edits_created ON code_project_edits(project_id, created_at);
      CREATE INDEX IF NOT EXISTS code_task_workspaces_project_updated ON code_task_workspaces(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS code_task_reviews_source_created ON code_task_reviews(source_run_id, created_at);
      CREATE INDEX IF NOT EXISTS workflow_versions_workflow_version ON workflow_versions(workflow_id, version DESC);
    `);

    this.addColumn("bots", "owner_id TEXT");
    this.addColumn("memories", "revision TEXT");
    this.addColumn("memories", "source TEXT NOT NULL DEFAULT 'legacy'");
    this.addColumn("memories", "source_run_id TEXT");
    this.addColumn("memories", "expires_at TEXT");
    this.db.exec("UPDATE memories SET revision=lower(hex(randomblob(16))) WHERE revision IS NULL");
    this.addColumn("bots", "provider_instance_id TEXT");
    this.addColumn("bots", "mascot TEXT NOT NULL DEFAULT 'orbit'");
    this.addColumn("bots", "avatar_version TEXT");
    this.addColumn("messages", "side_root_id TEXT");
    this.addColumn("runs", "side_root_id TEXT");
    this.addColumn("bots", "computer_enabled INTEGER NOT NULL DEFAULT 1");
    this.addColumn("bots", "browser_enabled INTEGER NOT NULL DEFAULT 1");
    this.addColumn("bots", "mac_access_enabled INTEGER NOT NULL DEFAULT 0");
    this.addColumn("bots", "autopilot INTEGER NOT NULL DEFAULT 0");
    this.addColumn("bots", "ai_mode TEXT NOT NULL DEFAULT 'chosen'");
    this.addColumn("bots", "weekly_token_budget INTEGER NOT NULL DEFAULT 250000");
    this.addColumn("threads", "section_name TEXT");
    this.addColumn("threads", "pinned INTEGER NOT NULL DEFAULT 0");
    this.addColumn("threads", "hidden INTEGER NOT NULL DEFAULT 0");
    this.addColumn("messages", "reply_to_id TEXT");
    this.addColumn("messages", "kind TEXT NOT NULL DEFAULT 'text'");
    this.addColumn("messages", "event_type TEXT");
    this.addColumn("messages", "event_data TEXT");
    this.addColumn("runs", "approval_id TEXT");
    this.addColumn("runs", "partial_text TEXT");
    this.addColumn("runs", "progress_at TEXT");
    this.addColumn("runs", "input_tokens INTEGER NOT NULL DEFAULT 0");
    this.addColumn("runs", "output_tokens INTEGER NOT NULL DEFAULT 0");
    this.addColumn("runs", "reasoning_tokens INTEGER NOT NULL DEFAULT 0");
    this.addColumn("runs", "cache_read_tokens INTEGER NOT NULL DEFAULT 0");
    this.addColumn("runs", "cache_write_tokens INTEGER NOT NULL DEFAULT 0");
    this.addColumn("runs", "cost REAL NOT NULL DEFAULT 0");
    this.addColumn("runs", "parent_run_id TEXT");
    this.addColumn("runs", "trigger_message_id TEXT");
    this.addColumn("runs", "outcome TEXT");
    this.addColumn("runs", "steered_from_run_id TEXT");
    this.addColumn("runs", "routine_id TEXT");
    this.addColumn("runs", "consultation_pending INTEGER NOT NULL DEFAULT 0");
    this.addColumn("runs", "expected_work_kind TEXT");
    this.addColumn("runs", "completion_repair_count INTEGER NOT NULL DEFAULT 0");
    this.addColumn("runs", "attachment_ids_json TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("runs", "task_goal TEXT");
    this.addColumn("runs", "task_deliverable TEXT");
    this.addColumn("runs", "task_approval_boundary TEXT");
    this.addColumn("runs", "task_required_apps_json TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("runs", "task_stage TEXT NOT NULL DEFAULT 'queued'");
    this.addColumn("runs", "task_steps_json TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("runs", "verification_status TEXT NOT NULL DEFAULT 'pending'");
    this.addColumn("runs", "verification_summary TEXT");
    this.addColumn("runs", "verification_checks_json TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("attachments", "detected_mime TEXT NOT NULL DEFAULT 'application/octet-stream'");
    this.addColumn("attachments", "kind TEXT NOT NULL DEFAULT 'file'");
    this.addColumn("attachments", "processing_status TEXT NOT NULL DEFAULT 'ready'");
    this.addColumn("attachments", "summary TEXT");
    this.addColumn("attachments", "extracted_text TEXT");
    this.addColumn("attachments", "metadata_json TEXT NOT NULL DEFAULT '{}'");
    this.addColumn("attachments", "previewable INTEGER NOT NULL DEFAULT 0");
    this.addColumn("attachments", "source TEXT NOT NULL DEFAULT 'upload'");
    this.addColumn("attachments", "artifact_key TEXT");
    this.addColumn("attachments", "revision INTEGER NOT NULL DEFAULT 1");
    this.addColumn("attachments", "replaces_attachment_id TEXT");
    this.addColumn("routines", "last_status TEXT NOT NULL DEFAULT 'never'");
    this.addColumn("routines", "run_count INTEGER NOT NULL DEFAULT 0");
    this.addColumn("routines", "trigger_type TEXT NOT NULL DEFAULT 'schedule'");
    this.addColumn("routines", "trigger_config_json TEXT NOT NULL DEFAULT '{}'");
    this.addColumn("routines", "webhook_secret_ciphertext TEXT");
    this.addColumn("routines", "consecutive_failures INTEGER NOT NULL DEFAULT 0");
    this.addColumn("routines", "deduplicated_count INTEGER NOT NULL DEFAULT 0");
    this.addColumn("routines", "last_error TEXT");
    this.addColumn("routines", "paused_reason TEXT");
    this.addColumn("routines", "revision INTEGER NOT NULL DEFAULT 1");
    this.addColumn("routines", "last_success_at TEXT");
    this.addColumn("routines", "last_event_at TEXT");
    this.addColumn("runs", "automation_event_id TEXT");
    this.addColumn("runs", "worker_id TEXT");
    this.addColumn("runs", "lease_expires_at TEXT");
    this.addColumn("runs", "attempt_count INTEGER NOT NULL DEFAULT 0");
    this.addColumn("runs", "recovered_at TEXT");
    this.addColumn("connectors", "credentials_ciphertext TEXT");
    this.addColumn("connectors", "authorization_version INTEGER NOT NULL DEFAULT 0");
    this.addColumn("connectors", "event_path_ciphertext TEXT");
    this.addColumn("connectors", "event_secret_ciphertext TEXT");
    this.addColumn("connectors", "event_verified_at TEXT");
    this.addColumn("taught_workflows", "skill_slug TEXT");
    this.addColumn("taught_workflows", "disabled INTEGER NOT NULL DEFAULT 0");
    this.addColumn("taught_workflows", "description TEXT NOT NULL DEFAULT ''");
    this.addColumn("taught_workflows", "instructions TEXT NOT NULL DEFAULT ''");
    this.addColumn("taught_workflows", "version INTEGER NOT NULL DEFAULT 1");
    this.addColumn("taught_workflows", "source TEXT NOT NULL DEFAULT 'taught'");
    this.addColumn("taught_workflows", "updated_at TEXT");
    const hadRoutineInterval = this.hasColumn("routines", "interval_minutes");
    this.addColumn("routines", "interval_minutes INTEGER NOT NULL DEFAULT 1440");
    this.addColumn("routines", "schedule_json TEXT");
    this.addColumn("code_projects", "connected INTEGER NOT NULL DEFAULT 1");
    this.addColumn("code_projects", "remote_url TEXT");
    this.addColumn("code_projects", "default_branch TEXT");
    this.addColumn("code_projects", "managed_clone INTEGER NOT NULL DEFAULT 0");
    this.addColumn("code_project_edits", "before_content TEXT");
    this.addColumn("code_project_edits", "after_hash TEXT");
    this.addColumn("code_project_edits", "workspace_run_id TEXT");
    this.addColumn("code_project_edits", "restored_at TEXT");
    if (!hadRoutineInterval) this.db.exec("UPDATE routines SET interval_minutes=CASE cadence WHEN 'hourly' THEN 60 ELSE 1440 END");
    this.addColumn("provider_instances", "runtime TEXT NOT NULL DEFAULT 'opencode'");
    this.addColumn("provider_instances", "api_config_json TEXT");
    this.addColumn("runs", "active_duration_ms INTEGER NOT NULL DEFAULT 0");
    this.addColumn("runs", "model_steps INTEGER NOT NULL DEFAULT 0");
    this.addColumn("runs", "model_override TEXT");
    this.addColumn("runs", "after_run_id TEXT");
    this.addColumn("bots", "retired_at TEXT");
    this.addColumn("action_journal", "mutation_key TEXT");
    this.addColumn("action_journal", "effect_digest TEXT");
    // Final trust-boundary pass: host-issued mutation identities. Tokens
    // are minted by the host (random, unguessable) with the canonical
    // effect digest bound AT MINT TIME — a first caller can never choose
    // what effect an already minted token represents. Reviewed
    // consequential work also binds the approval. Executors verify the
    // exact token/run/teammate/effect (+approval when approval-backed).
    // Durable, so the fence survives restarts.
    this.db.exec(`CREATE TABLE IF NOT EXISTS mutation_tokens (
      token TEXT PRIMARY KEY, run_id TEXT NOT NULL, bot_id TEXT NOT NULL,
      effect_digest TEXT, approval_id TEXT, created_at TEXT NOT NULL
    )`);
    this.addColumn("mutation_tokens", "effect_digest TEXT");
    this.addColumn("queue_items", "pattern TEXT");
    this.addColumn("queue_items", "meta_json TEXT");    this.db.exec("UPDATE taught_workflows SET updated_at=created_at WHERE updated_at IS NULL OR updated_at=''");
    this.db.exec(`INSERT OR IGNORE INTO workflow_versions (id,workflow_id,version,name,description,instructions,start_url,steps_json,created_at)
      SELECT lower(hex(randomblob(16))),id,COALESCE(version,1),name,COALESCE(description,''),COALESCE(instructions,''),start_url,steps_json,COALESCE(updated_at,created_at) FROM taught_workflows`);
    this.db.prepare("INSERT OR IGNORE INTO runner_state (id,mode,recovered_runs,dispatched_runs) VALUES ('primary','foreground',0,0)").run();
    this.db.prepare(`
      INSERT OR IGNORE INTO app_settings (setting_key, setting_value, updated_at)
      VALUES ('mac_access_enabled', CASE WHEN EXISTS(SELECT 1 FROM bots WHERE mac_access_enabled=1) THEN '1' ELSE '0' END, ?)
    `).run(now());
    const insertSetting = this.db.prepare("INSERT OR IGNORE INTO app_settings (setting_key,setting_value,updated_at) VALUES (?,?,?)");
    const settingsAt = now();
    insertSetting.run("runner_health_alerts_enabled", "0", settingsAt);
    insertSetting.run("runner_health_last_checked_at", "", settingsAt);
    insertSetting.run("runner_health_last_notified_at", "", settingsAt);
    insertSetting.run("runner_health_last_status", "", settingsAt);
    insertSetting.run("runner_health_last_signature", "", settingsAt);
    insertSetting.run("runner_external_heartbeat_enabled", "0", settingsAt);
    insertSetting.run("runner_external_heartbeat_url_ciphertext", "", settingsAt);
    insertSetting.run("runner_external_heartbeat_provider", "", settingsAt);
    insertSetting.run("runner_external_heartbeat_last_attempt_at", "", settingsAt);
    insertSetting.run("runner_external_heartbeat_last_success_at", "", settingsAt);
    insertSetting.run("runner_external_heartbeat_last_error", "", settingsAt);
    insertSetting.run("self_extend_enabled", "1", settingsAt);
    insertSetting.run("semantic_browser_enabled", "0", settingsAt);
    insertSetting.run("coding_model", "", settingsAt);
    insertSetting.run("embeddings_provider", "", settingsAt);
    insertSetting.run("embeddings_model", "", settingsAt);
    insertSetting.run("max_teammates", "12", settingsAt);
    insertSetting.run("yolo_mode", "0", settingsAt);
    this.db.exec(`UPDATE bots SET mac_access_enabled=CAST((SELECT setting_value FROM app_settings WHERE setting_key='mac_access_enabled') AS INTEGER)`);
  }

  private seed(seedStarterBots = false) {
    const createdAt = now();
    this.db.prepare("INSERT OR IGNORE INTO users (id, name, created_at) VALUES (?, ?, ?)").run(DEFAULT_OWNER, "Local owner", createdAt);
    this.db.prepare(`
      INSERT OR IGNORE INTO provider_instances
      (id, owner_id, provider, name, auth_mode, runtime, env_name, created_at, updated_at)
      VALUES ('local-opencode', ?, 'opencode', 'My OpenCode', 'cli', 'opencode', NULL, ?, ?)
    `).run(DEFAULT_OWNER, createdAt, createdAt);

    this.db.prepare("INSERT OR IGNORE INTO threads (id,title,kind,bot_id,created_at,updated_at) VALUES ('team-room','The studio','room',NULL,?,?)").run(createdAt, createdAt);
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM bots").get() as Row;
    if (seedStarterBots && Number(count.count) === 0) {
      const bots = [
        {
          id: "nova", name: "Nova", emoji: "✦", mascot: "nova", color: "#6757d9", role: "Researcher",
          instructions: "Find the signal in the noise. Research carefully, keep sources and turn discoveries into clear next steps.",
        },
        {
          id: "pixel", name: "Pixel", emoji: "●", mascot: "blob", color: "#ef6a8a", role: "Maker",
          instructions: "Turn ideas into tangible, polished things. Prefer simple solutions, inspect your work and explain what changed.",
        },
        {
          id: "scout", name: "Scout", emoji: "▲", mascot: "sprout", color: "#27a67a", role: "Operator",
          instructions: "Organize work, notice blockers and carry tasks through. Be calm, practical and explicit about risky actions.",
        },
      ];
      const insertBot = this.db.prepare(`
        INSERT INTO bots
        (id, owner_id, provider_instance_id, name, emoji, mascot, color, role, instructions, model, ai_mode, created_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'automatic', ?)
      `);
      const insertThread = this.db.prepare(`INSERT INTO threads (id, title, kind, bot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
      const insertThreadBot = this.db.prepare("INSERT INTO thread_bots (thread_id, bot_id) VALUES (?, ?)");
      this.db.exec("BEGIN");
      try {
        for (const bot of bots) {
          insertBot.run(bot.id, DEFAULT_OWNER, bot.name, bot.emoji, bot.mascot, bot.color, bot.role, bot.instructions, "", createdAt);
          insertThread.run(`bot-${bot.id}`, bot.name, "direct", bot.id, createdAt, createdAt);
          insertThreadBot.run("team-room", bot.id);
          mkdirSync(path.join(this.workspacesDir, bot.id), { recursive: true });
        }
        this.addMessage({ threadId: "team-room", senderType: "system", senderId: null, body: "Your studio is ready. Pick a teammate or invite several into this room." });
        this.addMessage({ threadId: "bot-nova", senderType: "bot", senderId: "nova", body: "Hi, I’m Nova. Give me something tangled and I’ll help you make sense of it." });
        this.addMessage({ threadId: "bot-pixel", senderType: "bot", senderId: "pixel", body: "Ready when you are. We can start scrappy and make it lovely as we go." });
        this.addMessage({ threadId: "bot-scout", senderType: "bot", senderId: "scout", body: "I’m here. Hand me a loose end and I’ll keep it moving." });
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    this.db.prepare("UPDATE bots SET owner_id = COALESCE(owner_id, ?)").run(DEFAULT_OWNER);
    // Preserve pre-provider-schema OpenCode users, never configure a fresh bot.
    this.db.exec("UPDATE bots SET provider_instance_id='local-opencode' WHERE provider_instance_id IS NULL AND (model LIKE 'opencode/%' OR model LIKE 'opencode-go/%')");
    const mascotMap: Record<string, MascotKind> = { nova: "nova", pixel: "blob", scout: "sprout" };
    for (const [id, mascot] of Object.entries(mascotMap)) this.db.prepare("UPDATE bots SET mascot = ? WHERE id = ? AND mascot = 'orbit'").run(mascot, id);
    for (const bot of this.listBots()) mkdirSync(path.join(this.workspacesDir, bot.id), { recursive: true });
  }

  private botStatus(row: Row): Bot["status"] {
    if (row.waiting_run) return "waiting";
    if (row.active_run) return "working";
    if (row.latest_status === "failed") return "failed";
    if (row.latest_status === "completed" && row.latest_finished_at && Date.now() - new Date(String(row.latest_finished_at)).getTime() < 12_000) return "celebrating";
    return "ready";
  }

  private botFromRow(row: Row): Bot {
    return {
      id: String(row.id), ownerId: String(row.owner_id || DEFAULT_OWNER),
      providerInstanceId: row.provider_instance_id ? String(row.provider_instance_id) : null,
      name: String(row.name), emoji: String(row.emoji), mascot: String(row.mascot || "orbit") as MascotKind,
      avatarVersion: row.avatar_version ? String(row.avatar_version) : null,
      color: String(row.color), role: String(row.role), instructions: String(row.instructions), model: String(row.model),
      status: this.botStatus(row), currentAction: row.current_action ? String(row.current_action) : null,
      computerEnabled: asBoolean(row.computer_enabled), browserEnabled: asBoolean(row.browser_enabled), autopilot: asBoolean(row.autopilot), aiMode: row.ai_mode === "automatic" ? "automatic" : "chosen", macAccessEnabled: asBoolean(row.mac_access_enabled),
      weeklyTokenBudget: Number(row.weekly_token_budget || 0), tokensUsedThisWeek: Number(row.tokens_used_week || 0),
      createdAt: String(row.created_at), lastActiveAt: row.last_active_at ? String(row.last_active_at) : null,
      threadId: String(row.thread_id), retiredAt: row.retired_at ? String(row.retired_at) : null,
    };
  }

  private botSelect(where = "", order = "") {
    return `
      SELECT b.*, t.id AS thread_id,
        EXISTS(SELECT 1 FROM runs r WHERE r.bot_id=b.id AND r.status IN ('queued','running')) AS active_run,
        EXISTS(SELECT 1 FROM runs r WHERE r.bot_id=b.id AND r.status IN ('awaiting_approval','waiting_for_teammate')) AS waiting_run,
        (SELECT status FROM runs r WHERE r.bot_id=b.id ORDER BY created_at DESC LIMIT 1) AS latest_status,
        (SELECT finished_at FROM runs r WHERE r.bot_id=b.id ORDER BY created_at DESC LIMIT 1) AS latest_finished_at,
        (SELECT a.label FROM activities a WHERE a.bot_id=b.id AND a.run_id IN (SELECT id FROM runs WHERE bot_id=b.id AND status IN ('queued','running','awaiting_approval','waiting_for_teammate')) ORDER BY a.created_at DESC LIMIT 1) AS current_action,
        COALESCE((SELECT SUM(${WEEKLY_TOKENS_SQL}) FROM runs r WHERE r.bot_id=b.id AND r.created_at >= datetime('now','-7 days')),0) AS tokens_used_week
      FROM bots b JOIN threads t ON t.bot_id=b.id AND t.kind='direct' ${where} ${order}`;
  }

  listBots(includeRetired = false): Bot[] {
    return (this.db.prepare(this.botSelect(includeRetired ? "" : "WHERE b.retired_at IS NULL", "ORDER BY b.created_at ASC")).all() as Row[]).map((row) => this.botFromRow(row));
  }

  setBotAvatarVersion(id: string, version: string | null): Bot | null {
    this.db.prepare("UPDATE bots SET avatar_version = ? WHERE id = ?").run(version, id);
    return this.getBot(id);
  }

  getBot(id: string): Bot | null {
    const row = this.db.prepare(this.botSelect("WHERE b.id = ?")).get(id) as Row | undefined;
    return row ? this.botFromRow(row) : null;
  }

  /** Deterministic teammate resolution for handoffs and consultations.
   * Accepts an exact bot id or an unambiguous teammate name
   * (case-insensitive); anything else fails with the available roster so the
   * caller can retry with a real identity instead of guessing. Retired
   * teammates get their own actionable error. */
  resolveTeammate(reference: string): Bot {
    const trimmed = reference.trim();
    if (!trimmed) throw new Error("Choose a teammate first — no name or id was given.");
    const direct = this.getBot(trimmed);
    if (direct && !direct.retiredAt) return direct;
    const lowered = trimmed.toLowerCase();
    const all = this.listBots(true);
    const retired = all.find((bot) => Boolean(bot.retiredAt) && (bot.id === trimmed || bot.name.toLowerCase() === lowered || bot.id.toLowerCase() === lowered))
      || (direct?.retiredAt ? direct : undefined);
    if (retired) throw new Error(`${retired.name} is retired. Restore them before handing off work.`);
    const matches = all.filter((bot) => !bot.retiredAt && (bot.name.toLowerCase() === lowered || bot.id.toLowerCase() === lowered));
    if (matches.length === 1) return matches[0]!;
    throw new Error(matches.length
      ? `“${trimmed}” matches several teammates. Use one of these ids: ${matches.map((bot) => `${bot.id} (${bot.name}, ${bot.role})`).join("; ")}.`
      : `No teammate matches “${trimmed}”. Available: ${all.filter((bot) => !bot.retiredAt).map((bot) => `${bot.id} (${bot.name}, ${bot.role})`).join("; ") || "none"}.`);
  }

  getStudioSettings(): StudioSettings {
    const rows = this.db.prepare("SELECT setting_key,setting_value FROM app_settings WHERE setting_key IN ('mac_access_enabled','semantic_browser_enabled','self_extend_enabled','coding_model','embeddings_provider','embeddings_model','max_teammates','yolo_mode')").all() as Row[];
    const value = (key: string) => String((rows.find((row) => row.setting_key === key) as Row | undefined)?.setting_value ?? "");
    const maxTeammates = Math.max(1, Math.min(100, Number.parseInt(value("max_teammates") || "12", 10) || 12));
    return { macAccessEnabled: asBoolean(value("mac_access_enabled")), semanticBrowserEnabled: asBoolean(value("semantic_browser_enabled")), selfExtendEnabled: asBoolean(value("self_extend_enabled") || "1"), codingModel: value("coding_model") || null, embeddingsProviderInstanceId: value("embeddings_provider") || null, embeddingsModel: value("embeddings_model") || null, maxTeammates, yoloMode: asBoolean(value("yolo_mode")) };
  }

  updateStudioSettings(patch: Partial<StudioSettings>): StudioSettings {
    const current = this.getStudioSettings();
    const maxTeammates = patch.maxTeammates === undefined ? current.maxTeammates : Math.max(1, Math.min(100, Math.floor(patch.maxTeammates) || current.maxTeammates));
    const next = { ...current, ...patch, maxTeammates };
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE app_settings SET setting_value=?, updated_at=? WHERE setting_key='mac_access_enabled'").run(next.macAccessEnabled ? "1" : "0", now());
      this.db.prepare("UPDATE app_settings SET setting_value=?, updated_at=? WHERE setting_key='semantic_browser_enabled'").run(next.semanticBrowserEnabled ? "1" : "0", now());
      this.db.prepare("UPDATE bots SET mac_access_enabled=?").run(next.macAccessEnabled ? 1 : 0);
      this.db.prepare("UPDATE app_settings SET setting_value=?, updated_at=? WHERE setting_key='self_extend_enabled'").run(next.selfExtendEnabled ? "1" : "0", now());
      this.db.prepare("UPDATE app_settings SET setting_value=?, updated_at=? WHERE setting_key='coding_model'").run(next.codingModel || "", now());
      this.db.prepare("UPDATE app_settings SET setting_value=?, updated_at=? WHERE setting_key='embeddings_provider'").run(next.embeddingsProviderInstanceId || "", now());
      this.db.prepare("UPDATE app_settings SET setting_value=?, updated_at=? WHERE setting_key='embeddings_model'").run(next.embeddingsModel || "", now());
      this.db.prepare("UPDATE app_settings SET setting_value=?, updated_at=? WHERE setting_key='max_teammates'").run(String(next.maxTeammates), now());
      this.db.prepare("UPDATE app_settings SET setting_value=?, updated_at=? WHERE setting_key='yolo_mode'").run(next.yoloMode ? "1" : "0", now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getStudioSettings();
  }

  getRunnerHealthMonitorState(): {
    enabled: boolean;
    lastCheckedAt: string | null;
    lastNotifiedAt: string | null;
    lastStatus: "ready" | "attention" | null;
    lastSignature: string;
  } {
    const rows = this.db.prepare("SELECT setting_key,setting_value FROM app_settings WHERE setting_key LIKE 'runner_health_%'").all() as Row[];
    const values = new Map(rows.map((row) => [String(row.setting_key), String(row.setting_value || "")]));
    const status = values.get("runner_health_last_status");
    return {
      enabled: values.get("runner_health_alerts_enabled") === "1",
      lastCheckedAt: values.get("runner_health_last_checked_at") || null,
      lastNotifiedAt: values.get("runner_health_last_notified_at") || null,
      lastStatus: status === "ready" || status === "attention" ? status : null,
      lastSignature: values.get("runner_health_last_signature") || "",
    };
  }

  setRunnerHealthAlertsEnabled(enabled: boolean) {
    this.db.prepare("UPDATE app_settings SET setting_value=?,updated_at=? WHERE setting_key='runner_health_alerts_enabled'").run(enabled ? "1" : "0", now());
    return this.getRunnerHealthMonitorState();
  }

  recordRunnerHealthMonitorResult(input: {
    checkedAt: string;
    status: "ready" | "attention";
    signature: string;
    notifiedAt?: string;
  }) {
    const update = this.db.prepare("UPDATE app_settings SET setting_value=?,updated_at=? WHERE setting_key=?");
    this.db.exec("BEGIN");
    try {
      update.run(input.checkedAt, input.checkedAt, "runner_health_last_checked_at");
      update.run(input.status, input.checkedAt, "runner_health_last_status");
      update.run(input.signature.slice(0, 300), input.checkedAt, "runner_health_last_signature");
      if (input.notifiedAt) update.run(input.notifiedAt, input.checkedAt, "runner_health_last_notified_at");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRunnerHealthMonitorState();
  }

  getRunnerExternalHeartbeatState(): {
    enabled: boolean;
    url: string | null;
    provider: string | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  } {
    const rows = this.db.prepare("SELECT setting_key,setting_value FROM app_settings WHERE setting_key LIKE 'runner_external_heartbeat_%'").all() as Row[];
    const values = new Map(rows.map((row) => [String(row.setting_key), String(row.setting_value || "")]));
    const encrypted = values.get("runner_external_heartbeat_url_ciphertext") || "";
    let url: string | null = null;
    try { if (encrypted) url = this.vault.decrypt(encrypted); }
    catch { url = null; }
    return {
      enabled: values.get("runner_external_heartbeat_enabled") === "1" && Boolean(url),
      url,
      provider: values.get("runner_external_heartbeat_provider") || null,
      lastAttemptAt: values.get("runner_external_heartbeat_last_attempt_at") || null,
      lastSuccessAt: values.get("runner_external_heartbeat_last_success_at") || null,
      lastError: values.get("runner_external_heartbeat_last_error") || null,
    };
  }

  configureRunnerExternalHeartbeat(input: { enabled: boolean; url?: string | null; provider?: string | null }) {
    const current = this.getRunnerExternalHeartbeatState();
    const url = input.url === undefined ? current.url : input.url;
    const provider = input.provider === undefined ? current.provider : input.provider;
    const update = this.db.prepare("UPDATE app_settings SET setting_value=?,updated_at=? WHERE setting_key=?");
    const at = now();
    this.db.exec("BEGIN");
    try {
      update.run(input.enabled && url ? "1" : "0", at, "runner_external_heartbeat_enabled");
      update.run(url ? this.vault.encrypt(url) : "", at, "runner_external_heartbeat_url_ciphertext");
      update.run(provider?.slice(0, 160) || "", at, "runner_external_heartbeat_provider");
      if (!url) {
        update.run("", at, "runner_external_heartbeat_last_attempt_at");
        update.run("", at, "runner_external_heartbeat_last_success_at");
        update.run("", at, "runner_external_heartbeat_last_error");
      }
      if (!input.enabled) update.run("", at, "runner_external_heartbeat_last_error");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRunnerExternalHeartbeatState();
  }

  recordRunnerExternalHeartbeat(input: { attemptedAt: string; success: boolean; error?: string | null }) {
    const update = this.db.prepare("UPDATE app_settings SET setting_value=?,updated_at=? WHERE setting_key=?");
    this.db.exec("BEGIN");
    try {
      update.run(input.attemptedAt, input.attemptedAt, "runner_external_heartbeat_last_attempt_at");
      if (input.success) update.run(input.attemptedAt, input.attemptedAt, "runner_external_heartbeat_last_success_at");
      update.run(input.success ? "" : input.error?.replace(/\s+/g, " ").trim().slice(0, 240) || "The heartbeat service did not accept this check-in.", input.attemptedAt, "runner_external_heartbeat_last_error");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRunnerExternalHeartbeatState();
  }

  createBot(input: {
    name: string; emoji: string; mascot?: MascotKind; color: string; role: string; instructions: string; model?: string;
    providerInstanceId?: string | null; computerEnabled?: boolean; browserEnabled?: boolean; weeklyTokenBudget?: number; inheritAccess?: boolean;
    aiMode?: Bot["aiMode"];
  }): Bot {
    const maxTeammates = this.getStudioSettings().maxTeammates;
    if (this.listBots().length >= maxTeammates) throw new Error(`This studio has room for ${maxTeammates} teammate${maxTeammates === 1 ? "" : "s"}. Retire or raise the limit before adding another.`);
    const id = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "bot"}-${randomUUID().slice(0, 5)}`;
    const threadId = `bot-${id}`;
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO bots
      (id, owner_id, provider_instance_id, name, emoji, mascot, color, role, instructions, model, computer_enabled, browser_enabled, mac_access_enabled, weekly_token_budget, ai_mode, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, DEFAULT_OWNER, input.providerInstanceId || null, input.name, input.emoji, input.mascot || "orbit",
      input.color, input.role, input.instructions, input.model || "", input.computerEnabled === false ? 0 : 1,
      input.browserEnabled === false ? 0 : 1, this.getStudioSettings().macAccessEnabled ? 1 : 0,
      // A guard against runaway API bills, not a wall: ~100+ ordinary tasks a week.
      input.weeklyTokenBudget ?? 2_000_000, input.aiMode === "automatic" ? "automatic" : "chosen", createdAt,
    );
    this.db.prepare("INSERT INTO threads (id,title,kind,bot_id,created_at,updated_at) VALUES (?,?,'direct',?,?,?)").run(threadId, input.name, id, createdAt, createdAt);
    this.db.prepare("INSERT OR IGNORE INTO thread_bots (thread_id,bot_id) VALUES ('team-room',?)").run(id);
    const google = this.getConnector("google-workspace");
    if (input.inheritAccess && google?.connected) {
      this.setBotConnectorAccess(id, { canRead: true, canSend: true }, "gmail");
      this.setBotConnectorAccess(id, { canRead: true, canSend: false }, "google-drive");
      this.setBotConnectorAccess(id, { canRead: true, canSend: false }, "google-calendar");
    }
    mkdirSync(path.join(this.workspacesDir, id), { recursive: true });
    return this.getBot(id)!;
  }

  /** Retire a teammate: history is preserved, but they leave the roster and
   * cannot start new work. Restore brings them back subject to the cap. */
  retireBot(id: string): Bot | null {
    const result = this.db.prepare(
      "UPDATE bots SET retired_at=? WHERE id=? AND retired_at IS NULL",
    ).run(now(), id);
    return result.changes === 1 ? this.getBot(id) : null;
  }

  restoreBot(id: string): Bot | null {
    const bot = this.getBot(id);
    if (!bot || !bot.retiredAt) return null;
    const maxTeammates = this.getStudioSettings().maxTeammates;
    if (this.listBots().length >= maxTeammates) throw new Error(`This studio has room for ${maxTeammates} teammate${maxTeammates === 1 ? "" : "s"}. Retire or raise the limit before restoring.`);
    this.db.prepare("UPDATE bots SET retired_at=NULL WHERE id=?").run(id);
    return this.getBot(id);
  }

  updateBot(id: string, patch: Partial<Pick<Bot, "name" | "role" | "instructions" | "model" | "mascot" | "color" | "computerEnabled" | "browserEnabled" | "autopilot" | "weeklyTokenBudget" | "providerInstanceId" | "aiMode">>): Bot | null {
    const current = this.getBot(id);
    if (!current) return null;
    this.db.prepare(`UPDATE bots SET name=?, role=?, instructions=?, model=?, mascot=?, color=?, computer_enabled=?, browser_enabled=?, autopilot=?, mac_access_enabled=?, weekly_token_budget=?, provider_instance_id=? WHERE id=?`).run(
      patch.name ?? current.name, patch.role ?? current.role, patch.instructions ?? current.instructions, patch.model ?? current.model,
      patch.mascot ?? current.mascot, patch.color ?? current.color, (patch.computerEnabled ?? current.computerEnabled) ? 1 : 0,
      (patch.browserEnabled ?? current.browserEnabled) ? 1 : 0, (patch.autopilot ?? current.autopilot) ? 1 : 0, current.macAccessEnabled ? 1 : 0, patch.weeklyTokenBudget ?? current.weeklyTokenBudget,
      patch.providerInstanceId === undefined ? current.providerInstanceId : patch.providerInstanceId, id,
    );
    if (patch.aiMode) this.db.prepare("UPDATE bots SET ai_mode=? WHERE id=?").run(patch.aiMode, id);
    if (patch.name) this.db.prepare("UPDATE threads SET title=? WHERE bot_id=?").run(patch.name, id);
    return this.getBot(id);
  }

  duplicateBot(id: string): Bot | null {
    const source = this.getBot(id);
    if (!source) return null;
    const copy = this.createBot({
      name: `${source.name} copy`.slice(0, 30), emoji: source.emoji, mascot: source.mascot, color: source.color,
      role: source.role, instructions: source.instructions, model: source.model, providerInstanceId: source.providerInstanceId,
      weeklyTokenBudget: source.weeklyTokenBudget, aiMode: source.aiMode,
    });
    this.updateBot(copy.id, { computerEnabled: source.computerEnabled, browserEnabled: source.browserEnabled });
    this.db.prepare("DELETE FROM bot_connector_access WHERE bot_id=?").run(copy.id);
    this.db.prepare(`INSERT INTO bot_connector_access (bot_id,connector_id,service,can_read,can_send,created_at,updated_at)
      SELECT ?,connector_id,service,can_read,can_send,?,? FROM bot_connector_access WHERE bot_id=?`).run(copy.id, now(), now(), source.id);
    this.db.prepare(`INSERT INTO bot_project_access (bot_id,project_id,can_read,can_write,can_run,created_at,updated_at)
      SELECT ?,project_id,can_read,can_write,can_run,?,? FROM bot_project_access WHERE bot_id=?`).run(copy.id, now(), now(), source.id);
    const sourceThread = this.getThread(source.threadId);
    if (sourceThread) this.updateThread(copy.threadId, { section: sourceThread.section });
    return this.getBot(copy.id);
  }

  listThreads(): Thread[] {
    // Needs-you per thread: an open owner approval, or a teammate handing a
    // judgment call to the owner (@user/@owner) in the current turn. The
    // escalation scan is re-validated in JS so substrings like "bob@user"
    // never raise a false badge.
    const openApprovals = new Set((this.db.prepare("SELECT DISTINCT thread_id FROM runs WHERE status='awaiting_approval' AND parent_run_id IS NULL").all() as Row[]).map((row) => String(row.thread_id)));
    const escalationRows = this.db.prepare(`SELECT m.thread_id AS thread_id, m.body AS body FROM messages m
      WHERE m.sender_type='bot'
      AND m.rowid > COALESCE((SELECT MAX(m2.rowid) FROM messages m2 WHERE m2.thread_id=m.thread_id AND m2.sender_type='user'), 0)
      AND (m.body LIKE '%@user%' OR m.body LIKE '%@owner%')`).all() as Row[];
    const escalations = new Set(escalationRows.filter((row) => replyEscalatesToOwner(String(row.body))).map((row) => String(row.thread_id)));
    return (this.db.prepare(`SELECT t.*,
      (SELECT GROUP_CONCAT(tb.bot_id, ',') FROM thread_bots tb WHERE tb.thread_id=t.id) member_ids,
      (SELECT substr(m.body,1,240) FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.thread_id=t.id AND r.parent_run_id IS NULL ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) last_message,
      (SELECT m.created_at FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.thread_id=t.id AND r.parent_run_id IS NULL ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) last_message_at
      FROM threads t ORDER BY CASE kind WHEN 'room' THEN 0 ELSE 1 END, pinned DESC, COALESCE(section_name,''), updated_at DESC`).all() as Row[]).map((row) => ({
      id: String(row.id), title: String(row.title), kind: row.kind as Thread["kind"], botId: row.bot_id ? String(row.bot_id) : null,
      botIds: String(row.member_ids || "").split(",")[0] ? String(row.member_ids).split(",") : undefined,
      section: row.section_name ? String(row.section_name) : null, pinned: asBoolean(row.pinned), hidden: asBoolean(row.hidden),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), unreadCount: 0,
      needsYou: openApprovals.has(String(row.id)) || escalations.has(String(row.id)),
      lastMessage: row.last_message == null ? null : String(row.last_message), lastMessageAt: row.last_message_at == null ? null : String(row.last_message_at),
    }));
  }

  getThread(id: string): Thread | null {
    return this.listThreads().find((thread) => thread.id === id) || null;
  }

  /** One group turn = everything since the owner's last message. Counts the
   * teammate replies the turn has already spent (the reply budget), whether
   * anyone escalated to the owner, and whether the cap notice already fired,
   * so the same refusal never spams the room. */
  groupTurnState(threadId: string): { botMessages: number; escalates: boolean; capNotePosted: boolean } {
    const threshold = this.db.prepare("SELECT MAX(rowid) AS last FROM messages WHERE thread_id=? AND sender_type='user'").get(threadId) as Row | undefined;
    const since = Number(threshold?.last || 0);
    const rows = this.db.prepare("SELECT sender_type, body, event_type FROM messages WHERE thread_id=? AND rowid > ? AND sender_type IN ('bot','system')").all(threadId, since) as Row[];
    return {
      botMessages: rows.filter((row) => String(row.sender_type) === "bot").length,
      escalates: rows.some((row) => String(row.sender_type) === "bot" && replyEscalatesToOwner(String(row.body))),
      capNotePosted: rows.some((row) => String(row.event_type) === "group-cap"),
    };
  }

  /** How many teammate replies a message sits behind in its reply chain (an
   * owner message or a thread start is depth 0; each teammate reply adds 1).
   * This is the group "round" counter: it keeps @mention chains from folding
   * in on themselves. */
  replyChainDepth(messageId: string): number {
    const row = this.db.prepare(`WITH RECURSIVE chain(id, reply_to, bot_hops) AS (
      SELECT id, reply_to_id, 0 FROM messages WHERE id = ?
      UNION ALL
      SELECT m.id, m.reply_to_id, chain.bot_hops + 1 FROM messages m JOIN chain ON m.id = chain.reply_to
      WHERE m.sender_type='bot' AND chain.bot_hops < 8
    ) SELECT COALESCE(MAX(bot_hops), 0) AS depth FROM chain`).get(messageId) as Row | undefined;
    return Number(row?.depth || 0);
  }

  /** Group membership, richest first: explicit room members, then all bots
   * implicitly for the all-hands room. Context and routes validate against
   * these lists, so a member removed here loses the thread immediately. */
  createGroupThread(title: string, botIds: string[]): Thread {
    const clean = title.replace(/\s+/g, " ").trim().slice(0, 48);
    if (!clean) throw new Error("Give the group a short name.");
    const unique = [...new Set(botIds)].slice(0, 6);
    if (!unique.length) throw new Error("Add at least one teammate to the group.");
    for (const botId of unique) if (!this.getBot(botId)) throw new Error("Choose existing teammates only.");
    const members = unique;
    const id = `group-${randomUUID().slice(0, 12)}`;
    const createdAt = now();
    this.db.prepare("INSERT INTO threads (id,title,kind,bot_id,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, clean, "room", null, createdAt, createdAt);
    const insert = this.db.prepare("INSERT INTO thread_bots (thread_id,bot_id) VALUES (?,?)");
    for (const botId of members) insert.run(id, botId);
    const names = members.map((botId) => this.getBot(botId)!.name);
    this.addMessage({ threadId: id, senderType: "system", senderId: null, body: `The group "${clean}" now has ${names.join(", ")} in it.` });
    return this.getThread(id)!;
  }

  setGroupMembers(threadId: string, botIds: string[]): Thread | null {
    const thread = this.getThread(threadId);
    if (!thread || thread.kind !== "room" || thread.id === "team-room") return null;
    const unique = [...new Set(botIds)].slice(0, 6);
    if (!unique.length) throw new Error("A group needs at least one teammate.");
    for (const botId of unique) if (!this.getBot(botId)) throw new Error("Choose existing teammates only.");
    const before = this.db.prepare("SELECT bot_id FROM thread_bots WHERE thread_id=? ORDER BY rowid").all(threadId).map((row) => String((row as Row).bot_id));
    const added = unique.filter((botId) => !before.includes(botId));
    const removed = before.filter((botId) => !unique.includes(botId));
    this.db.prepare("DELETE FROM thread_bots WHERE thread_id=?").run(threadId);
    const insert = this.db.prepare("INSERT INTO thread_bots (thread_id,bot_id) VALUES (?,?)");
    for (const botId of unique) insert.run(threadId, botId);
    if (added.length || removed.length) {
      const parts = [
        ...added.map((botId) => `${this.getBot(botId)!.name} joined`),
        ...removed.map((botId) => `${this.getBot(botId)!.name} left`),
      ];
      this.addMessage({ threadId: threadId, senderType: "system", senderId: null, body: `${parts.join(" · ")} the group. This affects future tasks; work already started keeps running for its teammate.` });
    }
    this.db.prepare("UPDATE threads SET updated_at=? WHERE id=?").run(now(), threadId);
    return this.getThread(threadId);
  }

  renameGroupThread(threadId: string, title: string): Thread | null {
    const thread = this.getThread(threadId);
    if (!thread || thread.kind !== "room" || thread.id === "team-room") return null;
    const clean = title.replace(/\s+/g, " ").trim().slice(0, 48);
    if (!clean) throw new Error("Give the group a short name.");
    this.db.prepare("UPDATE threads SET title=?,updated_at=? WHERE id=?").run(clean, now(), threadId);
    return this.getThread(threadId);
  }

  updateThread(id: string, patch: Partial<Pick<Thread, "section" | "pinned" | "hidden">>): Thread | null {
    const current = this.getThread(id);
    if (!current || current.id === "team-room") return null;
    const section = patch.section === undefined ? current.section : patch.section?.replace(/\s+/g, " ").trim().slice(0, 40) || null;
    this.db.prepare("UPDATE threads SET section_name=?,pinned=?,hidden=?,updated_at=? WHERE id=?").run(
      section, (patch.pinned ?? current.pinned) ? 1 : 0, (patch.hidden ?? current.hidden) ? 1 : 0, now(), id,
    );
    return this.getThread(id);
  }

  getDraft(threadId: string): StudioDraft {
    const row = this.db.prepare("SELECT * FROM thread_drafts WHERE thread_id=?").get(threadId) as Row | undefined;
    return row ? {
      threadId: String(row.thread_id),
      body: String(row.body),
      source: row.source === "ios" ? "ios" : row.source === "macos" ? "macos" : "web",
      updatedAt: String(row.updated_at),
    } : { threadId, body: "", source: null, updatedAt: null };
  }

  saveDraft(threadId: string, body: string, source: "web" | "ios" | "macos"): StudioDraft | null {
    if (!this.getThread(threadId)) return null;
    const updatedAt = now();
    this.db.prepare(`
      INSERT INTO thread_drafts (thread_id,body,source,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET body=excluded.body,source=excluded.source,updated_at=excluded.updated_at
    `).run(threadId, body, source, updatedAt);
    return this.getDraft(threadId);
  }

  listDraftAttachments(threadId: string): Attachment[] {
    return (this.db.prepare(`SELECT a.* FROM draft_attachments d
      JOIN attachments a ON a.id=d.attachment_id AND a.thread_id=d.thread_id
      WHERE d.thread_id=? AND a.message_id IS NULL ORDER BY d.created_at,d.rowid
    `).all(threadId) as Row[]).map((row) => this.attachmentFromRow(row));
  }

  addDraftAttachment(threadId: string, attachmentId: string): Attachment[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.getThread(threadId)) throw new Error("That conversation is no longer available.");
      const attachment = this.getAttachment(attachmentId);
      if (!attachment || attachment.threadId !== threadId || attachment.messageId) {
        throw new Error("That file is missing, already sent, or belongs to another conversation.");
      }
      const selected = this.listDraftAttachments(threadId);
      if (!selected.some((file) => file.id === attachmentId) && selected.length >= 6) {
        throw new Error("A message can include up to six files.");
      }
      this.db.prepare("INSERT OR IGNORE INTO draft_attachments (thread_id,attachment_id,created_at) VALUES (?,?,?)").run(threadId, attachmentId, now());
      this.db.exec("COMMIT");
      return this.listDraftAttachments(threadId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeDraftAttachment(threadId: string, attachmentId: string): Attachment[] {
    // Unselecting a file never deletes the upload or a sent message's attachment.
    this.db.prepare("DELETE FROM draft_attachments WHERE thread_id=? AND attachment_id=?").run(threadId, attachmentId);
    return this.listDraftAttachments(threadId);
  }

  getThreadBots(threadId: string): Bot[] {
    const thread = this.getThread(threadId);
    if (!thread) return [];
    if (thread.botId) return [this.getBot(thread.botId)].filter((bot): bot is Bot => Boolean(bot));
    const rows = this.db.prepare("SELECT bot_id FROM thread_bots WHERE thread_id=? ORDER BY rowid").all(threadId) as Row[];
    return rows.map((row) => this.getBot(String(row.bot_id))).filter((bot): bot is Bot => Boolean(bot));
  }

  addMessage(input: { threadId: string; senderType: Message["senderType"]; senderId: string | null; body: string; runId?: string | null; replyToId?: string | null; sideRootId?: string | null; kind?: Message["kind"]; eventType?: string | null; eventData?: Record<string, string | number | boolean | null> }): Message {
    const id = randomUUID();
    const createdAt = now();
    const reply = input.replyToId ? this.getMessage(input.replyToId) : null;
    if (input.replyToId && (!reply || reply.threadId !== input.threadId)) throw new Error("That message is no longer available to reply to.");
    // A message belongs to a side thread when it is sent into one, replies to a
    // message that does, or comes from a run that started in one. Teammate
    // answers and their status lines follow the question without extra wiring.
    let sideRootId: string | null = input.sideRootId ?? reply?.sideRootId ?? null;
    if (input.sideRootId) {
      const root = this.getMessage(input.sideRootId);
      if (!root || root.threadId !== input.threadId || root.sideRootId || root.kind !== "text") throw new Error("That message can no longer start a side thread.");
    }
    if (!sideRootId && input.runId) {
      const row = this.db.prepare("SELECT side_root_id FROM runs WHERE id=? AND thread_id=?").get(input.runId, input.threadId) as Row | undefined;
      if (row?.side_root_id) sideRootId = String(row.side_root_id);
    }
    this.db.prepare("INSERT INTO messages (id,thread_id,sender_type,sender_id,body,created_at,run_id,reply_to_id,kind,event_type,event_data,side_root_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
      id, input.threadId, input.senderType, input.senderId, input.body, createdAt, input.runId ?? null, reply?.id || null,
      input.kind ?? "text", input.kind === "event" ? input.eventType ?? "note" : null,
      input.kind === "event" && input.eventData ? JSON.stringify(input.eventData) : null,
      sideRootId,
    );
    this.db.prepare("UPDATE threads SET updated_at=? WHERE id=?").run(createdAt, input.threadId);
    return this.getMessage(id)!;
  }

  private messageFromRow(row: Row): Message {
    const senderType = row.sender_type as Message["senderType"];
    return {
      id: String(row.id), threadId: String(row.thread_id), senderType, senderId: row.sender_id ? String(row.sender_id) : null,
      senderName: senderType === "user" ? "You" : senderType === "system" ? "Sidemates" : String(row.bot_name),
      senderEmoji: row.bot_emoji ? String(row.bot_emoji) : null, senderColor: row.bot_color ? String(row.bot_color) : null,
      senderMascot: row.bot_mascot ? String(row.bot_mascot) as MascotKind : null,
      body: String(row.body), createdAt: String(row.created_at), runId: row.run_id ? String(row.run_id) : null,
      progressUpdates: senderType === "bot" && row.run_id ? (this.db.prepare(
        "SELECT a.detail FROM activities a JOIN runs r ON r.id=a.run_id WHERE a.run_id=? AND a.bot_id=? AND r.thread_id=? AND a.kind='message' AND a.label='Progress update' AND a.created_at<=? ORDER BY a.created_at,a.rowid"
      ).all(String(row.run_id), String(row.sender_id), String(row.thread_id), String(row.created_at)) as Row[]).map((activity) => String(activity.detail || "")).filter(Boolean) : [],
      kind: (row.kind === "event" ? "event" : "text") as Message["kind"],
      eventType: row.event_type ? String(row.event_type) : null,
      eventData: row.event_data ? (() => { try { const parsed = JSON.parse(String(row.event_data)); return typeof parsed === "object" && parsed !== null ? parsed as Record<string, string | number | boolean | null> : null; } catch { return null; } })() : null,
      sideRootId: row.side_root_id ? String(row.side_root_id) : null,
      replyTo: row.reply_id ? {
        id: String(row.reply_id),
        senderName: row.reply_sender_type === "user" ? "You" : row.reply_sender_type === "system" ? "Sidemates" : String(row.reply_bot_name || "Teammate"),
        body: String(row.reply_body || "").replace(/\s+/g, " ").trim().slice(0, 220),
      } : null,
      reactions: (this.db.prepare("SELECT emoji,COUNT(*) count,MAX(CASE WHEN actor='owner' THEN 1 ELSE 0 END) reacted FROM message_reactions WHERE message_id=? GROUP BY emoji ORDER BY MIN(created_at)").all(String(row.id)) as Row[]).map((reaction) => ({ emoji: String(reaction.emoji), count: Number(reaction.count), reactedByYou: asBoolean(reaction.reacted) })),
      attachments: this.listMessageAttachments(String(row.id)),
    };
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare(`SELECT m.*,b.name bot_name,b.emoji bot_emoji,b.mascot bot_mascot,b.color bot_color,reply.id reply_id,reply.body reply_body,reply.sender_type reply_sender_type,reply_bot.name reply_bot_name FROM messages m LEFT JOIN bots b ON b.id=m.sender_id LEFT JOIN messages reply ON reply.id=m.reply_to_id LEFT JOIN bots reply_bot ON reply_bot.id=reply.sender_id WHERE m.id=?`).get(id) as Row | undefined;
    return row ? this.messageFromRow(row) : null;
  }

  /** The system event message a run emitted for a given event type (e.g.
   * run_stopped). Used to attach partial-result files to the stop notice so
   * the receipt and evidence export can find them. */
  messageForRunEvent(runId: string, eventType: string): Message | null {
    const row = this.db.prepare(`SELECT m.*,b.name bot_name,b.emoji bot_emoji,b.mascot bot_mascot,b.color bot_color FROM messages m LEFT JOIN bots b ON b.id=m.sender_id WHERE m.run_id=? AND m.event_type=? ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1`).get(runId, eventType) as Row | undefined;
    return row ? this.messageFromRow(row) : null;
  }

  listMessages(threadId: string, limit = 120, offset = 0): Message[] {
    const rows = this.db.prepare(`SELECT * FROM (SELECT m.*,m.rowid message_rowid,b.name bot_name,b.emoji bot_emoji,b.mascot bot_mascot,b.color bot_color,reply.id reply_id,reply.body reply_body,reply.sender_type reply_sender_type,reply_bot.name reply_bot_name FROM messages m LEFT JOIN bots b ON b.id=m.sender_id LEFT JOIN messages reply ON reply.id=m.reply_to_id LEFT JOIN bots reply_bot ON reply_bot.id=reply.sender_id WHERE m.thread_id=? ORDER BY m.created_at DESC,m.rowid DESC LIMIT ? OFFSET ?) ORDER BY created_at ASC,message_rowid ASC`).all(threadId, limit, Math.max(0, offset)) as Row[];
    return rows.map((row) => this.messageFromRow(row));
  }

  /** Delivered identity must not depend on how much chat history is loaded. */
  listRunArtifacts(runId: string): Attachment[] {
    return (this.db.prepare(`SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id JOIN runs r ON r.id=m.run_id
      WHERE r.id=? AND a.thread_id=r.thread_id AND a.source='artifact' ORDER BY a.created_at,a.rowid`).all(runId) as Row[])
      .map((row) => this.attachmentFromRow(row));
  }

  toggleMessageReaction(messageId: string, emoji: string): Message | null {
    const message = this.getMessage(messageId);
    if (!message) return null;
    const existing = this.db.prepare("SELECT 1 present FROM message_reactions WHERE message_id=? AND emoji=? AND actor='owner'").get(messageId, emoji) as Row | undefined;
    if (existing) this.db.prepare("DELETE FROM message_reactions WHERE message_id=? AND emoji=? AND actor='owner'").run(messageId, emoji);
    else this.db.prepare("INSERT INTO message_reactions (message_id,emoji,actor,created_at) VALUES (?,?,'owner',?)").run(messageId, emoji, now());
    return this.getMessage(messageId);
  }

  searchStudio(rawQuery: string, limit = 40): StudioSearchResult[] {
    const query = rawQuery.replace(/\s+/g, " ").trim().slice(0, 100);
    if (query.length < 2) return [];
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const results: StudioSearchResult[] = [];
    for (const bot of this.listBots().filter((item) => `${item.name} ${item.role} ${item.instructions}`.toLowerCase().includes(query.toLowerCase())).slice(0, 8)) {
      results.push({ id: bot.id, kind: "teammate", title: bot.name, subtitle: bot.role, snippet: bot.instructions.slice(0, 220), threadId: bot.threadId, botId: bot.id, createdAt: bot.lastActiveAt || bot.createdAt });
    }
    const messages = this.db.prepare(`SELECT m.id,m.thread_id,m.body,m.created_at,m.sender_type,b.id bot_id,b.name bot_name,t.title thread_title
      FROM messages m LEFT JOIN bots b ON b.id=m.sender_id JOIN threads t ON t.id=m.thread_id
      WHERE m.body LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT 18`).all(pattern) as Row[];
    for (const row of messages) results.push({
      id: String(row.id), kind: "message", title: row.sender_type === "user" ? "You" : row.sender_type === "system" ? "Sidemates" : String(row.bot_name || "Teammate"),
      subtitle: String(row.thread_title), snippet: String(row.body).replace(/\s+/g, " ").trim().slice(0, 220), threadId: String(row.thread_id),
      botId: row.bot_id ? String(row.bot_id) : null, createdAt: String(row.created_at),
    });
    const files = this.db.prepare(`SELECT a.id,a.thread_id,a.name,a.summary,a.extracted_text,a.created_at,t.title thread_title,t.bot_id
      FROM attachments a JOIN threads t ON t.id=a.thread_id
      WHERE a.name LIKE ? ESCAPE '\\' OR COALESCE(a.summary,'') LIKE ? ESCAPE '\\' OR COALESCE(a.extracted_text,'') LIKE ? ESCAPE '\\'
      ORDER BY a.created_at DESC LIMIT 12`).all(pattern, pattern, pattern) as Row[];
    for (const row of files) results.push({
      id: String(row.id), kind: "file", title: String(row.name), subtitle: String(row.thread_title),
      snippet: String(row.summary || row.extracted_text || "Saved file").replace(/\s+/g, " ").trim().slice(0, 220), threadId: String(row.thread_id),
      botId: row.bot_id ? String(row.bot_id) : null, createdAt: String(row.created_at),
    });
    const routines = this.db.prepare(`SELECT r.id,r.name,r.prompt,r.thread_id,r.bot_id,r.last_run_at,r.next_run_at,b.name bot_name
      FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.name LIKE ? ESCAPE '\\' OR r.prompt LIKE ? ESCAPE '\\'
      ORDER BY COALESCE(r.last_run_at,r.next_run_at) DESC LIMIT 10`).all(pattern, pattern) as Row[];
    for (const row of routines) results.push({ id: String(row.id), kind: "routine", title: String(row.name), subtitle: `${row.bot_name} · Automation`, snippet: String(row.prompt).replace(/\s+/g, " ").trim().slice(0, 220), threadId: String(row.thread_id), botId: String(row.bot_id), createdAt: String(row.last_run_at || row.next_run_at || "1970-01-01T00:00:00.000Z") });
    const skills = this.db.prepare(`SELECT w.id,w.name,w.start_url,w.created_at,w.bot_id,b.name bot_name,t.id thread_id
      FROM taught_workflows w JOIN bots b ON b.id=w.bot_id JOIN threads t ON t.bot_id=b.id AND t.kind='direct'
      WHERE w.name LIKE ? ESCAPE '\\' OR w.start_url LIKE ? ESCAPE '\\' ORDER BY w.created_at DESC LIMIT 10`).all(pattern, pattern) as Row[];
    for (const row of skills) results.push({ id: String(row.id), kind: "skill", title: String(row.name), subtitle: `${row.bot_name} · Learned skill`, snippet: String(row.start_url), threadId: String(row.thread_id), botId: String(row.bot_id), createdAt: String(row.created_at) });
    return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, Math.max(1, Math.min(limit, 60)));
  }

  createAttachment(input: { threadId: string; messageId?: string | null; name: string; mime: string; size: number; storagePath: string; analysis?: AttachmentAnalysis; source?: Attachment["source"]; artifactKey?: string | null; revision?: number; replacesAttachmentId?: string | null }): Attachment {
    const id = path.basename(path.dirname(input.storagePath));
    const createdAt = now();
    const analysis = input.analysis;
    this.db.prepare("INSERT INTO attachments (id,thread_id,message_id,name,mime,detected_mime,kind,processing_status,summary,extracted_text,metadata_json,previewable,source,artifact_key,revision,replaces_attachment_id,size,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      id, input.threadId, input.messageId ?? null, input.name, input.mime, analysis?.detectedMime || input.mime, analysis?.kind || "file", analysis?.processingStatus || "ready",
      analysis?.summary ?? null, analysis?.extractedText ?? null, JSON.stringify(analysis?.metadata || {}), analysis?.previewable ? 1 : 0, input.source || "upload", input.artifactKey ?? null,
      input.revision || 1, input.replacesAttachmentId ?? null, input.size, input.storagePath, createdAt,
    );
    return this.getAttachment(id)!;
  }

  /** A browser result must never leave a chat message claiming a saved file
   * without its attachment row. Both records commit or neither does. */
  createBrowserResult(input: { threadId: string; botId: string; runId: string; body: string; name: string; mime: string; size: number; storagePath: string; analysis: AttachmentAnalysis; artifactKey: string }): Attachment {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const message = this.addMessage({ threadId: input.threadId, senderType: "bot", senderId: input.botId, runId: input.runId, body: input.body });
      const attachment = this.createAttachment({ threadId: input.threadId, messageId: message.id, name: input.name, mime: input.mime, size: input.size, storagePath: input.storagePath, analysis: input.analysis, source: "artifact", artifactKey: input.artifactKey });
      this.db.exec("COMMIT");
      return attachment;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  findBrowserResult(runId: string, name: string, size: number, resource: string, sha256: string): Attachment | null {
    const rows = this.db.prepare("SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.source='artifact' AND m.run_id=? AND a.name=? AND a.size=? ORDER BY a.created_at DESC LIMIT 24").all(runId, name, size) as Row[];
    for (const row of rows) {
      const attachment = this.attachmentFromRow(row);
      if (attachment.metadata?.browserResource === resource && attachment.metadata?.sha256 === sha256) return attachment;
    }
    return null;
  }

  private attachmentFromRow(row: Row): Attachment {
    const id = String(row.id);
    return {
      id, threadId: String(row.thread_id), messageId: row.message_id ? String(row.message_id) : null,
      name: String(row.name), mime: String(row.mime), detectedMime: String(row.detected_mime || row.mime),
      kind: String(row.kind || "file") as Attachment["kind"], processingStatus: String(row.processing_status || "ready") as Attachment["processingStatus"],
      summary: row.summary ? String(row.summary) : null, previewText: row.extracted_text ? String(row.extracted_text).slice(0, 4_000) : null,
      metadata: jsonRecord(row.metadata_json), previewUrl: asBoolean(row.previewable) ? `/api/attachments/${id}/preview` : null,
      source: String(row.source || "upload") as Attachment["source"], revision: Number(row.revision || 1), replacesAttachmentId: row.replaces_attachment_id ? String(row.replaces_attachment_id) : null,
      size: Number(row.size), url: `/api/attachments/${id}`,
      createdAt: String(row.created_at),
    };
  }

  getAttachment(id: string): Attachment | null {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id=?").get(id) as Row | undefined;
    return row ? this.attachmentFromRow(row) : null;
  }

  attachmentFile(id: string): { attachment: Attachment; storagePath: string } | null {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id=?").get(id) as Row | undefined;
    if (!row) return null;
    return { attachment: this.attachmentFromRow(row), storagePath: String(row.storage_path) };
  }

  listBotSavedFileRecords(botId: string): Array<{ attachment: Attachment; storagePath: string; sha256: string; savedAt: string }> {
    const rows = this.db.prepare(`SELECT a.*,s.sha256,s.created_at saved_at FROM bot_saved_files s
      JOIN attachments a ON a.id=s.attachment_id WHERE s.bot_id=? ORDER BY s.created_at,s.rowid`).all(botId) as Row[];
    return rows.map((row) => ({ attachment: this.attachmentFromRow(row), storagePath: String(row.storage_path), sha256: String(row.sha256), savedAt: String(row.saved_at) }));
  }

  addBotSavedFile(botId: string, attachmentId: string, sha256: string): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO bot_saved_files(bot_id,attachment_id,sha256,created_at) VALUES (?,?,?,?)").run(botId, attachmentId, sha256, now());
    return Number(result.changes) === 1;
  }

  removeBotSavedFile(botId: string, attachmentId: string): boolean {
    const result = this.db.prepare("DELETE FROM bot_saved_files WHERE bot_id=? AND attachment_id=?").run(botId, attachmentId);
    return Number(result.changes) === 1;
  }

  /** Agent courier: a machine-to-machine inbox so the local builder and the
   * tunnel-connected tester coordinate without the owner ferrying messages.
   * Bounded plain text, no secrets, owner-visible. */
  sendCourierMessage(input: { sender: string; recipient: string; kind: string; subject: string; body: string; refs?: string[] }): { id: string; createdAt: string } {
    const sender = input.sender.trim().slice(0, 40) || "unknown";
    const recipient = input.recipient.trim().slice(0, 40) || "unknown";
    const kind = input.kind.trim().slice(0, 24) || "note";
    const subject = input.subject.trim().slice(0, 160);
    const body = input.body.trim().slice(0, 12_000);
    if (!subject || !body) throw new Error("Give the courier message a subject and a body.");
    const refs = [...new Set((input.refs || []).filter((ref) => typeof ref === "string").map((ref) => ref.slice(0, 200)))].slice(0, 20);
    const id = randomUUID(), createdAt = now();
    this.db.prepare("INSERT INTO courier_messages (id,sender,recipient,kind,subject,body,refs_json,created_at,read_at) VALUES (?,?,?,?,?,?,?,?,NULL)").run(
      id, sender, recipient, kind, subject, body, JSON.stringify(refs), createdAt,
    );
    // Bounded history per recipient: the courier is a channel, not storage.
    this.db.prepare(`DELETE FROM courier_messages WHERE recipient=? AND id NOT IN (SELECT id FROM courier_messages WHERE recipient=? ORDER BY created_at DESC,rowid DESC LIMIT 200)`).run(recipient, recipient);
    return { id, createdAt };
  }

  courierInbox(recipient: string, unreadOnly = false): Array<{ id: string; sender: string; kind: string; subject: string; body: string; refs: string[]; createdAt: string; readAt: string | null }> {
    const rows = this.db.prepare(
      `SELECT * FROM courier_messages WHERE recipient=? ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at ASC,rowid ASC LIMIT 100`,
    ).all(recipient.trim().slice(0, 40)) as Row[];
    return rows.map((row) => ({
      id: String(row.id), sender: String(row.sender), kind: String(row.kind),
      subject: String(row.subject), body: String(row.body),
      refs: jsonArray<string>(row.refs_json).filter((ref) => typeof ref === "string"),
      createdAt: String(row.created_at), readAt: row.read_at ? String(row.read_at) : null,
    }));
  }

  ackCourierMessage(id: string, recipient: string): boolean {
    const result = this.db.prepare("UPDATE courier_messages SET read_at=? WHERE id=? AND recipient=? AND read_at IS NULL").run(now(), id, recipient.trim().slice(0, 40));
    return result.changes > 0;
  }

  /** Staging-only reset: return the studio to a known state by removing
   * test activity while keeping identity and configuration (bots, providers,
   * connectors, settings, memories, skills). Runs are cancelled first so
   * nothing keeps writing mid-wipe. Everything here is test-owned by
   * construction — this method must only ever run on a staging database. */
  resetTestEnvironment(): Record<string, number> {
    const counts: Record<string, number> = {};
    const finished = now();
    this.db.exec("BEGIN");
    try {
      const cancellingRunIds = (this.db.prepare("SELECT id FROM runs WHERE status NOT IN ('completed','failed','cancelled')").all() as Row[]).map(row => String(row.id));
      this.db.prepare("UPDATE runs SET status='cancelled', finished_at=? WHERE status NOT IN ('completed','failed','cancelled')").run(finished);
      counts.cancelledRuns = Number((this.db.prepare("SELECT changes() AS n").get() as Row).n);
      for (const runId of cancellingRunIds) for (const listener of this.runStatusListeners) listener(runId, "cancelled");
      const wipe = (table: string, where = "") => {
        this.db.prepare(`DELETE FROM ${table}${where ? ` WHERE ${where}` : ""}`).run();
        counts[table] = Number((this.db.prepare("SELECT changes() AS n").get() as Row).n);
      };
      wipe("message_reactions");
      wipe("attachments");
      wipe("draft_attachments");
      wipe("messages");
      wipe("activities");
      wipe("agent_messages");
      wipe("approvals");
      wipe("approved_actions");
      wipe("runs");
      wipe("work_snapshots");
      wipe("code_task_reviews");
      wipe("code_check_receipts");
      wipe("thread_drafts");
      wipe("thread_bots", "thread_id NOT IN (SELECT id FROM threads WHERE id='team-room' OR id LIKE 'bot-%')");
      wipe("threads", "id != 'team-room' AND id NOT LIKE 'bot-%'");
      wipe("routines");
      wipe("automation_events");
      wipe("automation_alerts");
      wipe("automation_cursors");
      wipe("courier_messages");
      wipe("notification_outbox");
      wipe("notification_deliveries");
      wipe("auto_review_rules");
      wipe("queue_items");
      wipe("queue_rules");
      wipe("dedupe_keys");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const dir of ["attachments", "tester", "computers"]) {
      try {
        const target = path.join(this.dataDir, dir);
        mkdirSync(target, { recursive: true });
        for (const entry of readdirSync(target)) rmSync(path.join(target, entry), { recursive: true, force: true });
      } catch { /* Best effort; the database is already clean. */ }
    }
    return counts;
  }

  /** Tester fixture cleanup: delete an attachment only while it is still
   * unclaimed (no message references it). Claimed files are conversation
   * evidence and are never removed through this path. Returns the deleted
   * attachment's name, or null when there is nothing safe to delete. */
  deleteUnclaimedAttachment(id: string): string | null {
    const found = this.db.prepare("SELECT id,message_id FROM attachments WHERE id=?").get(id) as Row | undefined;
    if (!found || found.message_id) return null;
    const file = this.attachmentFile(id);
    this.db.prepare("DELETE FROM attachments WHERE id=?").run(id);
    if (file) {
      const directory = path.dirname(file.storagePath);
      try {
        if (directory.startsWith(this.attachmentsDir)) rmSync(directory, { recursive: true, force: true });
      } catch { /* The record is gone; a leftover file is harmless. */ }
    }
    return file?.attachment.name ?? id;
  }

  attachmentText(id: string): string | null {
    const row = this.db.prepare("SELECT extracted_text FROM attachments WHERE id=?").get(id) as Row | undefined;
    return row?.extracted_text ? String(row.extracted_text) : null;
  }

  latestArtifact(threadId: string, artifactKey: string): { id: string; revision: number } | null {
    const row = this.db.prepare("SELECT id,revision FROM attachments WHERE thread_id=? AND artifact_key=? ORDER BY revision DESC,created_at DESC LIMIT 1").get(threadId, artifactKey) as Row | undefined;
    return row ? { id: String(row.id), revision: Number(row.revision || 1) } : null;
  }

  /// Artifacts as first-class outputs: the newest revision of every bot-made
  /// file, with its revision count and where it came from.
  listArtifacts(limit = 80): ArtifactSummary[] {
    const rows = this.db.prepare(`
      SELECT a.*, t.title thread_title, b.name bot_name,
        (SELECT COUNT(*) FROM attachments r WHERE r.thread_id=a.thread_id AND r.artifact_key=a.artifact_key) revision_count
      FROM attachments a
      JOIN threads t ON t.id=a.thread_id
      LEFT JOIN messages m ON m.id=a.message_id
      LEFT JOIN runs r ON r.id=m.run_id
      LEFT JOIN bots b ON b.id=r.bot_id
      WHERE a.source='artifact' AND a.artifact_key IS NOT NULL
        AND a.id=(SELECT r2.id FROM attachments r2 WHERE r2.thread_id=a.thread_id AND r2.artifact_key=a.artifact_key ORDER BY r2.revision DESC,r2.created_at DESC LIMIT 1)
      ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`).all(limit) as Row[];
    return rows.map((row) => {
      const attachment = this.attachmentFromRow(row);
      return {
        id: attachment.id, threadId: attachment.threadId, threadTitle: String(row.thread_title || "Conversation"),
        botName: row.bot_name ? String(row.bot_name) : null,
        name: attachment.name, kind: attachment.kind, mime: attachment.mime, size: attachment.size,
        summary: attachment.summary, previewUrl: attachment.previewUrl, url: attachment.url,
        revision: attachment.revision, revisions: Math.max(1, Number(row.revision_count || 1)),
        createdAt: attachment.createdAt,
      };
    });
  }

  listArtifactRevisions(threadId: string, artifactKey: string): Attachment[] {
    return (this.db.prepare("SELECT * FROM attachments WHERE thread_id=? AND artifact_key=? ORDER BY revision DESC,created_at DESC").all(threadId, artifactKey) as Row[]).map((row) => this.attachmentFromRow(row));
  }

  findArtifact(id: string): { summary: ArtifactSummary; key: string } | null {
    const row = this.db.prepare(`
      SELECT a.*, t.title thread_title, b.name bot_name,
        (SELECT COUNT(*) FROM attachments r WHERE r.thread_id=a.thread_id AND r.artifact_key=a.artifact_key) revision_count
      FROM attachments a
      JOIN threads t ON t.id=a.thread_id
      LEFT JOIN messages m ON m.id=a.message_id
      LEFT JOIN runs r ON r.id=m.run_id
      LEFT JOIN bots b ON b.id=r.bot_id
      WHERE a.id=? AND a.source='artifact'`).get(id) as Row | undefined;
    if (!row) return null;
    const attachment = this.attachmentFromRow(row);
    return {
      key: String(row.artifact_key),
      summary: {
        id: attachment.id, threadId: attachment.threadId, threadTitle: String(row.thread_title || "Conversation"),
        botName: row.bot_name ? String(row.bot_name) : null,
        name: attachment.name, kind: attachment.kind, mime: attachment.mime, size: attachment.size,
        summary: attachment.summary, previewUrl: attachment.previewUrl, url: attachment.url,
        revision: attachment.revision, revisions: Math.max(1, Number(row.revision_count || 1)),
        createdAt: attachment.createdAt,
      },
    };
  }

  listMessageAttachments(messageId: string): Attachment[] {
    return (this.db.prepare("SELECT * FROM attachments WHERE message_id=? ORDER BY created_at ASC").all(messageId) as Row[]).map((row) => this.attachmentFromRow(row));
  }

  claimAttachments(ids: string[], messageId: string, threadId: string): Attachment[] {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return [];
    if (uniqueIds.length > 6) throw new Error("A message can include up to six files.");
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM attachments WHERE id IN (${placeholders}) AND thread_id=? AND message_id IS NULL`).all(...uniqueIds, threadId) as Row[];
    if (rows.length !== uniqueIds.length) throw new Error("One of those files is missing or already attached.");
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`UPDATE attachments SET message_id=? WHERE id IN (${placeholders})`).run(messageId, ...uniqueIds);
      this.db.prepare(`DELETE FROM draft_attachments WHERE thread_id=? AND attachment_id IN (${placeholders})`).run(threadId, ...uniqueIds);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listMessageAttachments(messageId);
  }

  createRun(input: { threadId: string; botId: string; prompt: string; status: RunStatus; approvalReason?: string | null; parentRunId?: string | null; steeredFromRunId?: string | null; sideRootId?: string | null; triggerMessageId?: string | null; routineId?: string | null; automationEventId?: string | null; attachmentIds?: string[]; expectedWorkKind?: Run["expectedWorkKind"]; afterRunId?: string | null }): Run {
    if (this.getBot(input.botId)?.retiredAt) throw new Error("This teammate is retired. Restore them before starting new work.");
    if (input.routineId) {
      const routine = this.getRoutine(input.routineId);
      if (routine) new WorkflowValidation(this).assertRoutine(routine);
    }
    const id = randomUUID();
    const tracked = shouldTrackTask(input.prompt, Boolean(input.parentRunId || input.steeredFromRunId || input.routineId));
    this.db.prepare(`INSERT INTO runs (id,thread_id,bot_id,prompt,status,approval_reason,created_at,parent_run_id,steered_from_run_id,trigger_message_id,routine_id,automation_event_id,progress_at,attachment_ids_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.threadId, input.botId, input.prompt, input.status, input.approvalReason ?? null, now(), input.parentRunId ?? null, input.steeredFromRunId ?? null, input.triggerMessageId ?? null, input.routineId ?? null, input.automationEventId ?? null, now(), JSON.stringify([...new Set(input.attachmentIds || [])].slice(0, 6)),
    );
    this.db.prepare(`UPDATE runs SET task_goal=?,task_deliverable=?,task_approval_boundary=?,task_required_apps_json='[]',task_stage=?,task_steps_json=?,verification_status='pending',verification_summary=NULL,verification_checks_json='[]' WHERE id=?`).run(
      tracked ? taskGoal(input.prompt) : null, tracked ? "A finished, reviewable result in this conversation" : null, input.approvalReason ?? null,
      input.status === "awaiting_approval" ? "waiting" : "queued", JSON.stringify(tracked ? startingTaskSteps() : []), id,
    );
    // Work started inside a side thread stays there: started from a message in
    // one, from a message that belongs to one, or as help for a run that does.
    const sideRootId = input.sideRootId
      ?? (input.triggerMessageId ? this.getMessage(input.triggerMessageId)?.sideRootId : null)
      ?? (input.parentRunId ? this.getRun(input.parentRunId)?.sideRootId : null)
      ?? null;
    if (sideRootId) this.db.prepare("UPDATE runs SET side_root_id=? WHERE id=?").run(sideRootId, id);
    const previous = input.steeredFromRunId ? this.getRun(input.steeredFromRunId) : null;
    this.db.prepare("UPDATE runs SET expected_work_kind=?,completion_repair_count=? WHERE id=?").run(input.expectedWorkKind ?? previous?.expectedWorkKind ?? null, previous?.completionRepairCount || 0, id);
    if (input.status === "awaiting_approval" && input.approvalReason) {
      const approval = this.createApproval({ runId: id, botId: input.botId, kind: "prompt", reason: input.approvalReason, actionLabel: input.prompt.slice(0, 180), action: { type: "run" } });
      this.db.prepare("UPDATE runs SET approval_id=? WHERE id=?").run(approval.id, id);
    }
    if (input.afterRunId) this.db.prepare("UPDATE runs SET after_run_id=?,task_stage='waiting' WHERE id=?").run(input.afterRunId, id);
    if (input.routineId) new WorkflowValidation(this).bindRun(id, input.routineId);
    return this.getRun(id)!;
  }

  /** Tasks waiting for a teammate's answer in the same conversation. */
  runsWaitingFor(runId: string): Run[] {
    return (this.db.prepare(this.runSelect("WHERE r.after_run_id=? AND r.status='waiting_for_teammate' AND r.consultation_pending=0 ORDER BY r.created_at ASC")).all(runId) as Row[]).map((row) => this.runFromRow(row));
  }

  /** Starts a waiting task with what it needs to know about the earlier answer. */
  releaseRunAfter(id: string, prompt: string): Run | null {
    const changed = this.db.prepare("UPDATE runs SET prompt=?,status='queued',task_stage='working',progress_at=? WHERE id=? AND status='waiting_for_teammate' AND consultation_pending=0").run(prompt, now(), id).changes === 1;
    if (changed) for (const listener of this.runStatusListeners) listener(id, "queued");
    return changed ? this.getRun(id) : null;
  }

  private runFromRow(row: Row): Run {
    const id = String(row.id);
    const activities = (this.db.prepare("SELECT * FROM activities WHERE run_id=? ORDER BY created_at ASC").all(id) as Row[]).map((activity) => ({
      id: String(activity.id), runId: String(activity.run_id), botId: String(activity.bot_id), kind: activity.kind as Activity["kind"],
      label: String(activity.label), detail: activity.detail ? String(activity.detail) : null, createdAt: String(activity.created_at),
    }));
    const steps = jsonArray<TaskStep>(row.task_steps_json).filter((step) => Number.isInteger(step.id) && typeof step.title === "string");
    const task: TaskContract = {
      tracked: Boolean(row.task_goal),
      goal: row.task_goal ? String(row.task_goal) : taskGoal(String(row.prompt)),
      deliverable: row.task_deliverable ? String(row.task_deliverable) : "A useful result in this conversation",
      approvalBoundary: row.task_approval_boundary ? String(row.task_approval_boundary) : null,
      requiredApps: jsonArray<string>(row.task_required_apps_json).filter((item) => typeof item === "string"),
      stage: (row.task_stage || "queued") as TaskStage,
      steps,
      verificationStatus: (row.verification_status || "pending") as TaskVerificationStatus,
      verificationSummary: row.verification_summary ? String(row.verification_summary) : null,
      verificationChecks: jsonArray<TaskVerificationCheck>(row.verification_checks_json)
        .filter((check) => typeof check.label === "string" && typeof check.passed === "boolean")
        .map((check) => ({
          label: check.label,
          passed: check.passed,
          source: check.source === "host" ? "host" : "teammate",
          detail: typeof check.detail === "string" ? check.detail : null,
          predicate: typeof check.predicate === "string" ? check.predicate : null,
          inputDigest: typeof check.inputDigest === "string" ? check.inputDigest : null,
          outputDigest: typeof check.outputDigest === "string" ? check.outputDigest : null,
          observedAt: typeof check.observedAt === "string" ? check.observedAt : null,
        })),
    };
    return {
      id, threadId: String(row.thread_id), botId: String(row.bot_id), botName: String(row.bot_name), botEmoji: String(row.bot_emoji),
      review: this.extensionRecord<NonNullable<Run["review"]>>("run-review", id),
      botMascot: String(row.bot_mascot || "orbit") as MascotKind, botColor: String(row.bot_color), parentRunId: row.parent_run_id ? String(row.parent_run_id) : null,
      steeredFromRunId: row.steered_from_run_id ? String(row.steered_from_run_id) : null, triggerMessageId: row.trigger_message_id ? String(row.trigger_message_id) : null, sideRootId: row.side_root_id ? String(row.side_root_id) : null, routineId: row.routine_id ? String(row.routine_id) : null,
      automationEventId: row.automation_event_id ? String(row.automation_event_id) : null,
      outcome: row.outcome === "delivered" || row.outcome === "blocked" ? row.outcome : null,
      attemptCount: Number(row.attempt_count || 0), recoveredAt: row.recovered_at ? String(row.recovered_at) : null,
      consultationPending: asBoolean(row.consultation_pending),
      afterRunId: row.after_run_id ? String(row.after_run_id) : null,
      expectedWorkKind: ["morning", "inbox", "meeting", "weekly"].includes(String(row.expected_work_kind)) ? row.expected_work_kind as Run["expectedWorkKind"] : null,
      completionRepairCount: Number(row.completion_repair_count || 0),
      attachmentIds: jsonArray<string>(row.attachment_ids_json).filter((id) => typeof id === "string"),
      prompt: String(row.prompt), status: row.status as RunStatus,
      approvalReason: row.approval_reason ? String(row.approval_reason) : null, approvalId: row.approval_id ? String(row.approval_id) : null,
      partialText: row.partial_text ? String(row.partial_text) : null, startedAt: row.started_at ? String(row.started_at) : null,
      modelOverride: row.model_override ? String(row.model_override) : null,
      finishedAt: row.finished_at ? String(row.finished_at) : null, progressAt: row.progress_at ? String(row.progress_at) : null,
      summary: row.summary ? String(row.summary) : null, error: row.error ? String(row.error) : null,
      inputTokens: Number(row.input_tokens || 0), outputTokens: Number(row.output_tokens || 0), reasoningTokens: Number(row.reasoning_tokens || 0),
      cacheReadTokens: Number(row.cache_read_tokens || 0), cacheWriteTokens: Number(row.cache_write_tokens || 0), cost: Number(row.cost || 0), activities, task,
      activeDurationMs: Number(row.active_duration_ms || 0), modelSteps: Number(row.model_steps || 0),
    };
  }

  private runSelect(where: string) {
    return `SELECT r.*,b.name bot_name,b.emoji bot_emoji,b.mascot bot_mascot,b.color bot_color FROM runs r JOIN bots b ON b.id=r.bot_id ${where}`;
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare(this.runSelect("WHERE r.id=?")).get(id) as Row | undefined;
    return row ? this.runFromRow(row) : null;
  }

  getJobUsage(runId: string): { rootRunId: string; runIds: string[]; totalTokens: number } {
    // Steering continues the same outcome. UNION also bounds malformed cyclic
    // legacy relationships without counting a run more than once.
    const root = this.db.prepare(`WITH RECURSIVE ancestors(id,previous) AS (
      SELECT id,COALESCE(parent_run_id,steered_from_run_id) FROM runs WHERE id=?
      UNION SELECT r.id,COALESCE(r.parent_run_id,r.steered_from_run_id)
      FROM runs r JOIN ancestors a ON r.id=a.previous
    ) SELECT id FROM ancestors WHERE previous IS NULL`).get(runId) as Row | undefined;
    if (!root) throw new Error("The original job could not be found.");
    const rows = this.db.prepare(`WITH RECURSIVE family(id) AS (
      SELECT id FROM runs WHERE id=?
      UNION SELECT r.id FROM runs r JOIN family f ON COALESCE(r.parent_run_id,r.steered_from_run_id)=f.id
    ) SELECT r.id,r.input_tokens,r.output_tokens,r.reasoning_tokens FROM runs r JOIN family f ON r.id=f.id`).all(root.id) as Row[];
    return {
      rootRunId: String(root.id), runIds: rows.map((row) => String(row.id)),
      totalTokens: rows.reduce((sum, row) => sum + Number(row.input_tokens || 0) + Number(row.output_tokens || 0) + Number(row.reasoning_tokens || 0), 0),
    };
  }

  taskTokenPolicy(runId: string): TaskTokenPolicy {
    const root = this.getJobUsage(runId).rootRunId;
    return this.extensionRecord<TaskTokenPolicy>("task-token-budget", root) || { extraTokens: 0, revision: 0, pendingApprovalId: null, paused: [] };
  }

  /** Host-only, durable pause of the whole outcome. Model tools cannot grant
   * tokens. Unexecuted action reviews are withdrawn, not silently approved. */
  pauseForTaskTokens(runId: string): Approval | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const usage = this.getJobUsage(runId), policy = this.taskTokenPolicy(runId);
      if (policy.pendingApprovalId) { this.db.exec("COMMIT"); return this.getApproval(policy.pendingApprovalId); }
      const active = usage.runIds.map(id => this.getRun(id)!).filter(run => ["queued", "running", "awaiting_approval", "waiting_for_teammate"].includes(run.status));
      if (!active.length) { this.db.exec("COMMIT"); return null; }
      const owner = active.find(run => run.id === usage.rootRunId) || active.find(run => !run.parentRunId) || active.find(run => run.id === runId) || active[0]!;
      policy.paused = active.map(run => ({ id: run.id, status: run.status as TaskTokenPolicy["paused"][number]["status"] }));
      for (const run of active) {
        this.db.prepare("DELETE FROM approved_actions WHERE run_id=? AND status='prepared'").run(run.id);
        this.db.prepare("UPDATE approvals SET status='denied',decided_at=? WHERE run_id=? AND status='pending'").run(now(), run.id);
        this.updateRun(run.id, { status: "awaiting_approval", taskStage: "waiting", error: null, finishedAt: null, approvalReason: "This task needs your permission to use more tokens." });
        this.db.prepare("UPDATE runs SET approval_id=NULL WHERE id=?").run(run.id);
      }
      const approval = this.createApproval({ runId: owner.id, botId: owner.botId, kind: "budget", reason: "Sidemates paused this task at its token limit. Saved work and completed actions are kept. You decide whether it can use more.", actionLabel: `Allow ${TASK_TOKEN_TOP_UP.toLocaleString()} more tokens for this task`, action: { type: "task_tokens", botId: owner.botId, args: { rootRunId: usage.rootRunId, additionalTokens: TASK_TOKEN_TOP_UP, revision: policy.revision } } });
      policy.pendingApprovalId = approval.id;
      this.saveExtensionRecord("task-token-budget", usage.rootRunId, policy);
      this.addActivity({ runId: owner.id, botId: owner.botId, kind: "status", label: "Paused for more tokens", detail: "This task is waiting for a bounded allowance. Other tasks, weekly limits and action permissions are unchanged." });
      this.db.exec("COMMIT");
      return approval;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  setTaskTokenAmount(approvalId: string, amount: unknown): Approval | null {
    const parsed = taskTokenAmountSchema.safeParse(amount);
    const approval = this.getApproval(approvalId), action = taskTokenRequestSchema.safeParse(this.getApprovalAction(approvalId));
    if (!parsed.success || !approval || approval.kind !== "budget" || approval.status !== "pending" || !action.success) return null;
    const policy = this.taskTokenPolicy(approval.runId);
    if (policy.pendingApprovalId !== approvalId || policy.revision !== action.data.args.revision) return null;
    action.data.args.additionalTokens = parsed.data;
    this.db.prepare("UPDATE approvals SET action_json=?,action_label=? WHERE id=? AND status='pending'").run(JSON.stringify(action.data), `Allow ${parsed.data.toLocaleString()} more tokens for this task`, approvalId);
    return this.getApproval(approvalId);
  }

  taskTokenReview(approvalId: string, limits: Pick<ExecutionLimits, "maxTokens" | "maxJobTokens">): TaskTokenReview | null {
    const approval = this.getApproval(approvalId), parsed = taskTokenRequestSchema.safeParse(this.getApprovalAction(approvalId));
    if (!approval || approval.kind !== "budget" || !parsed.success || parsed.data.botId !== approval.botId) return null;
    const usage = this.getJobUsage(approval.runId), policy = this.taskTokenPolicy(approval.runId);
    if (usage.rootRunId !== parsed.data.args.rootRunId || policy.pendingApprovalId !== approvalId || policy.revision !== parsed.data.args.revision || approval.status !== "pending") return null;
    const paused = policy.paused.map(item => this.getRun(item.id)).filter((run): run is Run => Boolean(run));
    const overrun = Math.max(policy.extraTokens, usage.totalTokens - limits.maxJobTokens, ...paused.map(run => run.inputTokens + run.outputTokens + run.reasoningTokens - limits.maxTokens));
    const extraTokens = overrun + parsed.data.args.additionalTokens;
    const inFlight = usage.runIds.some(id => this.db.prepare("SELECT 1 FROM approved_actions WHERE run_id=? AND status='running'").get(id));
    const budgetBlocked = paused.some(run => !this.budgetAvailable(run.botId).allowed);
    const invalid = !paused.length || paused.some(run => run.status !== "awaiting_approval" || !this.getBot(run.botId) || this.getBot(run.botId)?.retiredAt) || !policy.paused.some(item => item.id === approval.runId) || !Number.isSafeInteger(extraTokens);
    return {
      usedTokens: usage.totalTokens, currentJobLimit: limits.maxJobTokens + policy.extraTokens,
      newJobLimit: limits.maxJobTokens + extraTokens, additionalTokens: parsed.data.args.additionalTokens, extraTokens,
      models: [...new Set(paused.map(run => `${run.botName}: ${run.modelOverride || this.getBot(run.botId)?.model || 'No model selected'}`))],
      limitation: invalid ? "This task changed. Refresh its status before deciding." : inFlight ? "An already-approved action is finishing. Wait for its recorded result before continuing." : budgetBlocked ? "A teammate's weekly allowance is also exhausted. This task-only approval cannot override it." : null,
    };
  }

  /** The owner route checks a fresh review fingerprint before entering this
   * atomic grant. Counters, receipts, sessions, plans and permissions stay put. */
  decideTaskTokens(approvalId: string, decision: "approved" | "denied", limits: Pick<ExecutionLimits, "maxTokens" | "maxJobTokens">): Approval | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const approval = this.getApproval(approvalId), action = taskTokenRequestSchema.safeParse(this.getApprovalAction(approvalId));
      if (!approval || !action.success || approval.status !== "pending") { this.db.exec("COMMIT"); return null; }
      const policy = this.taskTokenPolicy(approval.runId), review = this.taskTokenReview(approvalId, limits);
      if (policy.pendingApprovalId !== approvalId || (decision === "approved" && (!review || review.limitation))) { this.db.exec("COMMIT"); return null; }
      this.db.prepare("UPDATE approvals SET status=?,decided_at=? WHERE id=? AND status='pending'").run(decision, now(), approvalId);
      for (const item of policy.paused) {
        const run = this.getRun(item.id);
        if (!run || run.status !== "awaiting_approval") continue;
        if (decision === "denied") {
          this.updateRun(run.id, { status: "cancelled", finishedAt: now(), approvalReason: null, taskStage: "blocked" });
          this.finishRunTask(run.id, "cancelled");
        } else {
          // A coordinator must still wait for its unfinished consultants.
          this.updateRun(run.id, { status: run.consultationPending ? "waiting_for_teammate" : "queued", taskStage: run.consultationPending ? "waiting" : "working", approvalReason: null, error: null, finishedAt: null, progressAt: now() });
        }
        this.db.prepare("UPDATE runs SET approval_id=NULL WHERE id=?").run(run.id);
      }
      if (decision === "approved") { policy.extraTokens = review!.extraTokens; policy.revision += 1; }
      policy.pendingApprovalId = null; policy.paused = [];
      this.saveExtensionRecord("task-token-budget", action.data.args.rootRunId, policy);
      this.db.prepare("UPDATE automation_alerts SET resolved_at=? WHERE run_id=? AND kind='approval' AND resolved_at IS NULL").run(now(), approval.runId);
      this.addActivity({ runId: approval.runId, botId: approval.botId, kind: "status", label: decision === "approved" ? "More tokens approved by you" : "Additional tokens declined", detail: decision === "approved" ? `${action.data.args.additionalTokens.toLocaleString()} more tokens for this outcome; resuming saved progress, not repeating completed actions.` : "The task is stopped. Saved work and completed actions are kept." });
      this.db.exec("COMMIT");
      return this.getApproval(approvalId);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  listRuns(threadId: string): Run[] {
    const rows = this.db.prepare(this.runSelect("WHERE r.thread_id=? ORDER BY r.created_at DESC LIMIT 40")).all(threadId) as Row[];
    return rows.map((row) => this.runFromRow(row));
  }

  /** Finished top-level tasks since a moment, for the weekly recap. */
  finishedRunsSince(sinceIso: string, limit = 500): Run[] {
    const rows = this.db.prepare(this.runSelect("WHERE r.status='completed' AND r.parent_run_id IS NULL AND r.finished_at>=? ORDER BY r.finished_at DESC LIMIT ?")).all(sinceIso, limit) as Row[];
    return rows.map((row) => this.runFromRow(row));
  }

  listStudioRuns(limit = 30): Run[] {
    const rows = this.db.prepare(this.runSelect(`WHERE r.status IN ('queued','running','awaiting_approval','waiting_for_teammate','failed') OR r.finished_at>=datetime('now','-1 day') ORDER BY CASE r.status WHEN 'awaiting_approval' THEN 0 WHEN 'waiting_for_teammate' THEN 1 WHEN 'running' THEN 2 WHEN 'queued' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END,r.created_at DESC LIMIT ?`)).all(Math.max(1, Math.min(limit, 80))) as Row[];
    return rows.map((row) => this.runFromRow(row));
  }

  runningRun(threadId: string, botId: string): Run | null {
    const row = this.db.prepare(this.runSelect("WHERE r.thread_id=? AND r.bot_id=? AND r.status IN ('running','waiting_for_teammate') ORDER BY r.created_at DESC LIMIT 1")).get(threadId, botId) as Row | undefined;
    return row ? this.runFromRow(row) : null;
  }

  nextQueuedRun(excludedBotIds: string[]): Run | null {
    const placeholders = excludedBotIds.length ? excludedBotIds.map(() => "?").join(",") : "''";
    const row = this.db.prepare(this.runSelect(`WHERE r.status='queued' AND r.bot_id NOT IN (${placeholders}) ORDER BY r.created_at ASC LIMIT 1`)).get(...excludedBotIds) as Row | undefined;
    return row ? this.runFromRow(row) : null;
  }

  claimNextQueuedRun(excludedBotIds: string[], workerId: string, leaseMs = 45_000): Run | null {
    const placeholders = excludedBotIds.length ? excludedBotIds.map(() => "?").join(",") : "''";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = this.db.prepare(`SELECT id FROM runs WHERE status='queued' AND bot_id NOT IN (${placeholders}) ORDER BY created_at ASC LIMIT 1`).get(...excludedBotIds) as Row | undefined;
      if (!row) return null;
      const claimedAt = now(), leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      const changed = this.db.prepare("UPDATE runs SET status='running',worker_id=?,lease_expires_at=?,attempt_count=attempt_count+1,started_at=COALESCE(started_at,?),progress_at=? WHERE id=? AND status='queued'").run(
        workerId, leaseExpiresAt, claimedAt, claimedAt, String(row.id),
      ).changes;
      if (changed) return this.getRun(String(row.id));
    }
    return null;
  }

  renewRunLeases(workerId: string, leaseMs = 45_000): number {
    return Number(this.db.prepare("UPDATE runs SET lease_expires_at=? WHERE worker_id=? AND status='running'").run(new Date(Date.now() + leaseMs).toISOString(), workerId).changes);
  }

  recoverExpiredRuns(): Run[] {
    const expired = this.db.prepare(this.runSelect("WHERE r.status='running' AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=?) ORDER BY r.created_at ASC")).all(now()) as Row[];
    if (!expired.length) return [];
    const recoveredAt = now();
    this.db.prepare("UPDATE runs SET status='queued',worker_id=NULL,lease_expires_at=NULL,recovered_at=?,progress_at=? WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?)").run(recoveredAt, recoveredAt, recoveredAt);
    return expired.map((row) => this.getRun(String(row.id))).filter((run): run is Run => Boolean(run));
  }

  requeueWorkerRuns(workerId: string): number {
    const recoveredAt = now();
    return Number(this.db.prepare("UPDATE runs SET status='queued',worker_id=NULL,lease_expires_at=NULL,recovered_at=?,progress_at=? WHERE status='running' AND worker_id=?").run(recoveredAt, recoveredAt, workerId).changes);
  }

  updateRun(id: string, patch: Partial<{
    status: RunStatus; approvalReason: string | null; approvalId: string | null; startedAt: string | null; finishedAt: string | null;
    progressAt: string | null; partialText: string | null; summary: string | null; error: string | null; sessionId: string | null; modelOverride: string | null;
    inputTokens: number; outputTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cost: number; taskStage: TaskStage;
    activeDurationMs: number; modelSteps: number; outcome: "delivered" | "blocked" | null;
  }>) {
    const current = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Row | undefined;
    if (!current) return;
    const value = <K extends keyof typeof patch>(key: K, column: string) => patch[key] === undefined ? current[column] : patch[key];
    this.db.prepare(`UPDATE runs SET status=?,approval_reason=?,approval_id=?,started_at=?,finished_at=?,progress_at=?,partial_text=?,summary=?,error=?,session_id=?,model_override=?,input_tokens=?,output_tokens=?,reasoning_tokens=?,cache_read_tokens=?,cache_write_tokens=?,cost=?,task_stage=?,outcome=? WHERE id=?`).run(
      value("status", "status"), value("approvalReason", "approval_reason"), value("approvalId", "approval_id"), value("startedAt", "started_at"),
      value("finishedAt", "finished_at"), value("progressAt", "progress_at"), value("partialText", "partial_text"), value("summary", "summary"),
      value("error", "error"), value("sessionId", "session_id"), value("modelOverride", "model_override") ?? null, value("inputTokens", "input_tokens"), value("outputTokens", "output_tokens"),
      value("reasoningTokens", "reasoning_tokens"), value("cacheReadTokens", "cache_read_tokens"), value("cacheWriteTokens", "cache_write_tokens"), value("cost", "cost"), value("taskStage", "task_stage"), value("outcome", "outcome"), id,
    );
    if (patch.activeDurationMs !== undefined || patch.modelSteps !== undefined) this.db.prepare("UPDATE runs SET active_duration_ms=?,model_steps=? WHERE id=?").run(
      patch.activeDurationMs ?? current.active_duration_ms, patch.modelSteps ?? current.model_steps, id,
    );
    if (patch.status && patch.status !== "running") this.db.prepare("UPDATE runs SET worker_id=NULL,lease_expires_at=NULL WHERE id=?").run(id);
    if (patch.status === "running" || patch.status === "completed") this.db.prepare("UPDATE bots SET last_active_at=? WHERE id=?").run(now(), current.bot_id);
    const statusChanged = patch.status !== undefined && patch.status !== current.status;
    if (statusChanged && !current.parent_run_id && ["completed", "failed", "awaiting_approval"].includes(String(patch.status))) {
      const bot = this.getBot(String(current.bot_id));
      const title = patch.status === "completed" ? `${bot?.name || "A teammate"} finished` : patch.status === "failed" ? `${bot?.name || "A teammate"} needs a hand` : `${bot?.name || "A teammate"} needs your okay`;
      const body = patch.status === "completed" ? "Your result is ready to review." : patch.status === "failed" ? (patch.error || "Sidemates could not finish this task.") : (patch.approvalReason || String(current.approval_reason || "Sidemates is waiting for your decision."));
      // A run that prepared cards says so, and the tap opens the list instead of the chat.
      const cards = patch.status === "completed" ? (this.db.prepare("SELECT title FROM queue_items WHERE run_id=? AND status='ready' ORDER BY created_at ASC").all(id) as Row[]).map((row) => String(row.title)) : [];
      this.enqueueNotification(cards.length
        ? { dedupeKey: `run:${id}:${patch.status}`, kind: String(patch.status), title: cards.length === 1 ? "One thing is waiting for you" : `${cards.length} things are waiting for you`, body: `${cards[0]}${cards.length > 1 ? ` and ${cards.length - 1} more` : ""}. Nothing happens until you say so.`, url: "/?waiting=1" }
        : { dedupeKey: `run:${id}:${patch.status}`, kind: String(patch.status), title, body, url: `/?thread=${encodeURIComponent(String(current.thread_id))}` });
    }
    if (statusChanged && current.automation_event_id) {
      const eventStatus: AutomationEventStatus | null = patch.status === "awaiting_approval" ? "waiting" : ["queued", "running", "completed", "failed", "cancelled"].includes(patch.status!) ? patch.status as AutomationEventStatus : null;
      if (eventStatus) this.db.prepare("UPDATE automation_events SET status=?,finished_at=?,error=? WHERE id=?").run(
        eventStatus, ["completed", "failed", "cancelled"].includes(eventStatus) ? (patch.finishedAt || now()) : null,
        eventStatus === "failed" ? (patch.error || null) : null, current.automation_event_id,
      );
    }
    if (statusChanged && (patch.status === "completed" || patch.status === "failed") && current.routine_id) {
      if (patch.status === "completed") {
        this.db.prepare("UPDATE routines SET last_status='completed',run_count=run_count+1,consecutive_failures=0,last_error=NULL,last_success_at=? WHERE id=?").run(patch.finishedAt || now(), current.routine_id);
        this.db.prepare("UPDATE automation_alerts SET resolved_at=? WHERE routine_id=? AND resolved_at IS NULL AND kind IN ('failure','approval')").run(now(), current.routine_id);
      } else {
        const routine = this.getRoutine(String(current.routine_id));
        const failures = (routine?.consecutiveFailures || 0) + 1;
        const error = patch.error || "The automation stopped before it could finish.";
        const pause = failures >= 3;
        this.db.prepare("UPDATE routines SET last_status='failed',run_count=run_count+1,consecutive_failures=?,last_error=?,enabled=CASE WHEN ? THEN 0 ELSE enabled END,next_run_at=CASE WHEN ? THEN NULL ELSE next_run_at END,paused_reason=CASE WHEN ? THEN ? ELSE paused_reason END WHERE id=?").run(
          failures, error, pause ? 1 : 0, pause ? 1 : 0, pause ? 1 : 0, pause ? "Paused after three consecutive failures" : null, current.routine_id,
        );
        this.createAutomationAlert({
          routineId: String(current.routine_id), runId: id, eventId: current.automation_event_id ? String(current.automation_event_id) : null, kind: "failure",
          message: pause ? `${routine?.name || "This automation"} was paused after three failed attempts.` : `${routine?.name || "This automation"} needs another try: ${error}`,
        });
      }
    }
    if (statusChanged && patch.status === "awaiting_approval" && current.routine_id) {
      const routine = this.getRoutine(String(current.routine_id));
      this.createAutomationAlert({ routineId: String(current.routine_id), runId: id, eventId: current.automation_event_id ? String(current.automation_event_id) : null, kind: "approval", message: `${routine?.name || "An automation"} is waiting for your approval.` });
    }
    if (statusChanged) for (const listener of this.runStatusListeners) listener(id, patch.status!);
  }

  setRunPrompt(id: string, prompt: string) {
    this.db.prepare("UPDATE runs SET prompt=?,progress_at=? WHERE id=?").run(prompt, now(), id);
  }

  markRunConsultationPending(id: string) {
    this.db.prepare("UPDATE runs SET consultation_pending=1,progress_at=? WHERE id=?").run(now(), id);
  }

  retryMissingWorkReport(id: string): boolean {
    return this.db.prepare("UPDATE runs SET status='queued',completion_repair_count=completion_repair_count+1,partial_text=NULL,summary=NULL,error=NULL,finished_at=NULL,progress_at=? WHERE id=? AND status='running' AND expected_work_kind IS NOT NULL AND completion_repair_count=0").run(now(), id).changes === 1;
  }

  retryIntermediateTurn(id: string): boolean {
    return this.db.prepare("UPDATE runs SET status='queued',completion_repair_count=1,finished_at=NULL,error=NULL,progress_at=? WHERE id=? AND status='running' AND expected_work_kind IS NULL AND completion_repair_count=0").run(now(), id).changes === 1;
  }

  requireWorkReport(id: string, kind: NonNullable<Run["expectedWorkKind"]>) {
    const expected = this.getRun(id)?.expectedWorkKind;
    if (expected && expected !== kind) throw new Error(`This job needs a ${expected} report. Gather matching sources instead.`);
    this.db.prepare("UPDATE runs SET expected_work_kind=? WHERE id=? AND status='running'").run(kind, id);
  }

  pauseRunForConsultation(id: string): Run | null {
    this.db.prepare("UPDATE runs SET status='waiting_for_teammate',task_stage='waiting',partial_text=NULL,summary=NULL,error=NULL,finished_at=NULL,progress_at=? WHERE id=? AND consultation_pending=1").run(now(), id);
    return this.getRun(id);
  }

  listChildRuns(parentRunId: string): Run[] {
    return (this.db.prepare(this.runSelect("WHERE r.parent_run_id=? ORDER BY r.created_at ASC")).all(parentRunId) as Row[]).map((row) => this.runFromRow(row));
  }

  activeRunsForBot(botId: string): Run[] {
    return (this.db.prepare(this.runSelect("WHERE r.bot_id=? AND r.status IN ('queued','running','awaiting_approval','waiting_for_teammate') ORDER BY r.created_at ASC")).all(botId) as Row[]).map((row) => this.runFromRow(row));
  }

  hasPendingChildRuns(parentRunId: string): boolean {
    const row = this.db.prepare("SELECT EXISTS(SELECT 1 FROM runs WHERE parent_run_id=? AND status IN ('queued','running','awaiting_approval','waiting_for_teammate')) present").get(parentRunId) as Row | undefined;
    return asBoolean(row?.present);
  }

  readyConsultationCoordinators(): Run[] {
    const rows = this.db.prepare(this.runSelect("WHERE r.status='waiting_for_teammate' AND r.consultation_pending=1 AND NOT EXISTS(SELECT 1 FROM runs child WHERE child.parent_run_id=r.id AND child.status IN ('queued','running','awaiting_approval','waiting_for_teammate')) ORDER BY r.created_at ASC")).all() as Row[];
    return rows.map((row) => this.runFromRow(row));
  }

  /** Live delegations for the owner: who is paused waiting on whom, what was
   * asked, and whether the consultant's work is still moving. */
  listDelegations(): Delegation[] {
    const waiting = (this.db.prepare(this.runSelect("WHERE r.status='waiting_for_teammate' AND r.consultation_pending=1 ORDER BY r.created_at ASC")).all() as Row[]).map((row) => this.runFromRow(row));
    return waiting.map((run) => {
      const signals = (this.db.prepare(`${this.agentMessageSelect("WHERE am.run_id=? ORDER BY am.created_at ASC")}`).all(run.id) as Row[]).map((row) => this.agentMessageFromRow(row));
      return {
        runId: run.id, threadId: run.threadId, botId: run.botId, botName: run.botName,
        waitingSince: run.progressAt || run.startedAt || new Date(0).toISOString(),
        request: run.prompt.replace(/^The private consultation is complete[\s\S]*?Original request:\n/u, "").slice(0, 220),
        consultants: this.listChildRuns(run.id).map((child) => ({
          runId: child.id, botId: child.botId, botName: child.botName, status: child.status,
          detail: child.error || child.summary,
        })),
        signals: signals.map((signal) => ({ fromName: signal.fromBotName, toName: signal.toBotName, kind: signal.kind, body: signal.body.slice(0, 280) })),
      };
    });
  }

  resumeRunAfterConsultation(id: string, prompt: string): Run | null {
    this.db.prepare("UPDATE runs SET prompt=?,status='queued',consultation_pending=0,task_stage='working',partial_text=NULL,summary=NULL,error=NULL,finished_at=NULL,progress_at=? WHERE id=? AND status='waiting_for_teammate'").run(prompt, now(), id);
    return this.getRun(id);
  }

  startRunTask(id: string): TaskContract | null {
    const run = this.getRun(id);
    if (!run) return null;
    const steps = run.task.steps.length ? run.task.steps : startingTaskSteps();
    if (!steps.some((step) => step.status === "active")) {
      const first = steps.find((step) => step.status === "pending");
      if (first) first.status = "active";
    }
    const stage: TaskStage = run.task.stage === "queued" ? "planning" : run.task.stage === "waiting" ? "working" : run.task.stage;
    this.db.prepare("UPDATE runs SET task_stage=?,task_steps_json=?,progress_at=? WHERE id=?").run(stage, JSON.stringify(steps), now(), id);
    return this.getRun(id)!.task;
  }

  setRunTaskPlan(id: string, input: { goal: string; deliverable: string; approvalBoundary?: string | null; requiredApps?: string[]; steps: string[] }): TaskContract | null {
    if (!this.getRun(id)) return null;
    const titles = input.steps.map((item) => item.replace(/\s+/g, " ").trim().slice(0, 140)).filter(Boolean).slice(0, 8);
    if (!titles.length) throw new Error("Add at least one meaningful step.");
    const steps: TaskStep[] = titles.map((title, index) => ({ id: index + 1, title, status: index === 0 ? "active" : "pending", detail: null }));
    const requiredApps = [...new Set((input.requiredApps || []).map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, 8);
    this.db.prepare(`UPDATE runs SET task_goal=?,task_deliverable=?,task_approval_boundary=?,task_required_apps_json=?,task_stage='working',task_steps_json=?,verification_status='pending',verification_summary=NULL,verification_checks_json='[]',progress_at=? WHERE id=?`).run(
      input.goal.replace(/\s+/g, " ").trim().slice(0, 240), input.deliverable.replace(/\s+/g, " ").trim().slice(0, 240),
      input.approvalBoundary?.replace(/\s+/g, " ").trim().slice(0, 240) || null, JSON.stringify(requiredApps), JSON.stringify(steps), now(), id,
    );
    return this.getRun(id)!.task;
  }

  updateRunTaskStep(id: string, stepId: number, status: TaskStepStatus, detail?: string | null): TaskContract | null {
    const run = this.getRun(id);
    if (!run) return null;
    const steps = run.task.steps.map((step) => ({ ...step }));
    const step = steps.find((item) => item.id === stepId);
    if (!step) throw new Error("That task step does not exist.");
    if (status === "active") for (const item of steps) if (item.status === "active") item.status = "pending";
    step.status = status;
    step.detail = detail?.replace(/\s+/g, " ").trim().slice(0, 220) || null;
    let stage: TaskStage = status === "blocked" ? "blocked" : "working";
    if (status === "completed" && !steps.some((item) => item.status === "active")) {
      const next = steps.find((item) => item.status === "pending");
      if (next) next.status = "active";
    }
    if (steps.every((item) => ["completed", "skipped"].includes(item.status))) stage = "checking";
    this.db.prepare("UPDATE runs SET task_steps_json=?,task_stage=?,progress_at=? WHERE id=?").run(JSON.stringify(steps), stage, now(), id);
    return this.getRun(id)!.task;
  }

  verifyRunTask(id: string, input: { status: TaskVerificationStatus; summary: string; checks: TaskVerificationCheck[] }): TaskContract | null {
    const run = this.getRun(id);
    if (!run) return null;
    const checks = input.checks.map((check) => ({
      label: check.label.replace(/\s+/g, " ").trim().slice(0, 180),
      passed: check.passed,
      source: check.source === "host" ? "host" as const : "teammate" as const,
      detail: check.detail?.replace(/\s+/g, " ").trim().slice(0, 300) || null,
      // P06a contract survives persistence: digests stay comparable after
      // restart, refresh and reconnect instead of living only in memory.
      predicate: check.predicate?.slice(0, 120) ?? null,
      inputDigest: check.inputDigest ?? null,
      outputDigest: check.outputDigest ?? null,
      observedAt: check.observedAt ?? null,
    })).filter((check) => check.label).slice(0, 8);
    const status: TaskVerificationStatus = input.status === "passed" && checks.some((check) => !check.passed) ? "partial" : input.status;
    const steps = run.task.steps.map((step) => status === "passed" && !["blocked", "skipped"].includes(step.status) ? { ...step, status: "completed" as const } : step);
    const stage: TaskStage = status === "blocked" ? "blocked" : "checking";
    this.db.prepare("UPDATE runs SET verification_status=?,verification_summary=?,verification_checks_json=?,task_steps_json=?,task_stage=?,progress_at=? WHERE id=?").run(
      status, input.summary.replace(/\s+/g, " ").trim().slice(0, 500), JSON.stringify(checks), JSON.stringify(steps), stage, now(), id,
    );
    return this.getRun(id)!.task;
  }

  finishRunTask(id: string, outcome: "completed" | "failed" | "cancelled", detail?: string | null): TaskContract | null {
    const run = this.getRun(id);
    if (!run) return null;
    const steps = run.task.steps.map((step) => ({ ...step }));
    let verificationStatus = run.task.verificationStatus;
    let verificationSummary = run.task.verificationSummary;
    let checks = run.task.verificationChecks;
    let stage: TaskStage = "done";
    if (outcome === "completed") {
      if (verificationStatus === "pending") {
        verificationStatus = "partial";
        verificationSummary = "The result is ready, but it could not be fully checked automatically.";
        checks = [{ label: "A result was created", passed: true, source: "teammate" }, { label: "Final checks completed", passed: false, source: "teammate" }];
      }
      for (const step of steps) {
        if (step.status === "active") step.status = "completed";
        else if (step.status === "pending") step.status = verificationStatus === "passed" ? "completed" : "skipped";
      }
    } else {
      stage = "blocked";
      if (verificationStatus === "pending" || outcome === "failed") {
        verificationStatus = "blocked";
        verificationSummary = outcome === "cancelled" ? "Stopped by the user." : (detail || "The work stopped before it could be checked.").slice(0, 500);
        if (outcome === "cancelled") checks = [];
      }
      const active = steps.find((step) => step.status === "active");
      if (active) { active.status = "blocked"; active.detail = verificationSummary; }
    }
    this.db.prepare("UPDATE runs SET task_stage=?,task_steps_json=?,verification_status=?,verification_summary=?,verification_checks_json=?,progress_at=? WHERE id=?").run(
      stage, JSON.stringify(steps), verificationStatus, verificationSummary, JSON.stringify(checks), now(), id,
    );
    if (outcome === "failed" && !run.parentRunId && !this.db.prepare("SELECT 1 FROM messages WHERE run_id=? AND event_type='run_stopped'").get(id)) {
      const reason = detail || run.error || "The task stopped before it finished.";
      const title = /weekly.*(?:budget|token limit)/i.test(reason) ? "Weekly budget reached" : /free AI allowance/i.test(reason) ? "Free AI limit reached" : /(?:token|step|time|shared).*limit/i.test(reason) ? "Task limit reached" : /quota|rate.?limit|usage limit|credit balance/i.test(reason) ? "Provider limit reached" : /runtime not verified|could not check the installed OpenCode/i.test(reason) ? "Runtime update needed" : "Work stopped";
      this.addMessage({ threadId: run.threadId, senderType: "system", senderId: null, runId: id, kind: "event", eventType: "run_stopped", body: `${run.botName}: ${reason} Completed actions are not undone. Review the saved progress before retrying.`, eventData: { title, botId: run.botId, fix: JSON.stringify(fixFor(reason, { automatic: this.getBot(run.botId)?.aiMode === "automatic" })) } });
    }
    return this.getRun(id)!.task;
  }

  addActivity(input: Omit<Activity, "id" | "createdAt">): Activity {
    const activity: Activity = { ...input, id: randomUUID(), createdAt: now() };
    this.db.prepare("INSERT INTO activities (id,run_id,bot_id,kind,label,detail,created_at) VALUES (?,?,?,?,?,?,?)").run(activity.id, activity.runId, activity.botId, activity.kind, activity.label, activity.detail, activity.createdAt);
    this.db.prepare("UPDATE runs SET progress_at=? WHERE id=?").run(activity.createdAt, activity.runId);
    return activity;
  }

  botSessionFingerprint(botId: string): string {
    const bot = this.getBot(botId);
    const connectors = this.listConnectors().map((connection) => ({
      id: connection.id, connected: connection.connected, accountEmail: connection.accountEmail, scopes: [...connection.scopes].sort(),
      access: this.listBotConnectorAccess(connection.id).filter((item) => item.botId === botId).map((item) => ({ service: item.service, canRead: item.canRead, canSend: item.canSend })),
    }));
    const codeProjects = this.listCodeProjects(botId).map((project) => ({ id: project.id, canRead: true, access: project.access.find((item) => item.botId === botId) || null }));
    const serviceErrors = this.listConnectorServiceErrors().map((item) => item.service).sort();
    return JSON.stringify({
      bot: bot ? { name: bot.name, role: bot.role, instructions: bot.instructions, model: bot.model, providerInstanceId: bot.providerInstanceId, computerEnabled: bot.computerEnabled, browserEnabled: bot.browserEnabled } : null,
      providerConfig: bot ? this.providerForBot(bot.id)?.apiConfig || null : null,
      macAccessEnabled: this.getStudioSettings().macAccessEnabled,
      connectors, serviceErrors,
      codeProjects,
      bundledSkillsRevision,
      learnedSkills: this.listWorkflows(botId).map(({ id, version, disabled, skillSlug }) => ({ id, version, disabled, skillSlug })).sort((a, b) => a.id.localeCompare(b.id)),
      bundledSkillAccess: this.extensionRecords(BUNDLED_ACCESS_KIND),
      extensions: ["mcp", "community-skill"].map((kind) => this.extensionRecords<Record<string, unknown>>(kind).map(({ id, value }) => ({ id, revision: value.revision || value.digest, access: kind === "mcp" ? (value.grants as Record<string, unknown>)?.[botId] : (value.botIds as string[])?.includes(botId) }))),
      memoryRevision: this.extensionRecord<string>("memory-revision", botId),
      activeMemory: this.memoryEntries(botId).filter((note) => !note.conflict).map((note) => note.revision).sort(),
      savedFiles: this.listBotSavedFileRecords(botId).map((file) => ({ id: file.attachment.id, sha256: file.sha256 })).sort((a, b) => a.id.localeCompare(b.id)),
      savedFileToolsRevision: 1,
    });
  }

  rememberSessionCapabilities(sessionId: string, capabilityFingerprint: string) {
    this.db.prepare(`INSERT INTO model_sessions (session_id,capability_fingerprint,updated_at) VALUES (?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET capability_fingerprint=excluded.capability_fingerprint,updated_at=excluded.updated_at`).run(sessionId, capabilityFingerprint, now());
  }

  previousSession(threadId: string, botId: string, capabilityFingerprint?: string): string | null {
    const row = capabilityFingerprint
      ? this.db.prepare(`SELECT r.session_id FROM runs r JOIN model_sessions s ON s.session_id=r.session_id
          WHERE r.thread_id=? AND r.bot_id=? AND r.session_id IS NOT NULL AND s.capability_fingerprint=? ORDER BY r.created_at DESC LIMIT 1`).get(threadId, botId, capabilityFingerprint) as Row | undefined
      : this.db.prepare("SELECT session_id FROM runs WHERE thread_id=? AND bot_id=? AND session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(threadId, botId) as Row | undefined;
    return row?.session_id ? String(row.session_id) : null;
  }

  taskSession(runId: string, fingerprint: string, maxContext: number): { sessionId: string | null; continuing: boolean; reason: string } {
    const run = this.getRun(runId);
    if (!run) throw new Error("This task no longer exists.");
    // Reuse only this invocation or its steering ancestors, never a sibling's
    // private consultation. Parent/child jobs own separate runtime sessions.
    const ancestors = new Set([run.id]);
    let previous = run.steeredFromRunId;
    while (previous && !ancestors.has(previous)) { ancestors.add(previous); previous = this.getRun(previous)?.steeredFromRunId || null; }
    const candidates = this.db.prepare(`SELECT r.id,r.session_id,r.status,r.input_tokens,r.cache_read_tokens,r.parent_run_id,r.routine_id,r.expected_work_kind FROM runs r JOIN model_sessions s ON s.session_id=r.session_id
      WHERE r.thread_id=? AND r.bot_id=? AND s.capability_fingerprint=? ORDER BY r.created_at DESC,r.rowid DESC`).all(run.threadId, run.botId, fingerprint) as Row[];
    const sameTask = candidates.find(row => ancestors.has(String(row.id)));
    // The queue claim sets startedAt before the first provider invocation.
    // It is not evidence of an existing task context on its own.
    const continuing = Boolean(run.steeredFromRunId || run.modelSteps || run.inputTokens || run.outputTokens || run.activeDurationMs || run.attemptCount > 1);
    if (sameTask) return { sessionId: String(sameTask.session_id), continuing: true, reason: "same_task" };
    if (continuing) return { sessionId: null, continuing: true, reason: "context_changed" };
    if (run.parentRunId || run.routineId || run.expectedWorkKind) return { sessionId: null, continuing: false, reason: "isolated_task" };
    const latest = candidates[0];
    if (!latest) return { sessionId: null, continuing: false, reason: "new_context" };
    if (latest.status !== "completed" || latest.parent_run_id || latest.routine_id || latest.expected_work_kind) return { sessionId: null, continuing: false, reason: "isolated_task" };
    const observed = this.extensionRecord<{ peakInputTokens: number }>("model-session-context", String(latest.session_id));
    const footprint = observed?.peakInputTokens ?? (Number(latest.input_tokens || 0) + Number(latest.cache_read_tokens || 0));
    if (!Number.isFinite(footprint) || footprint <= 0 || footprint >= maxContext) return { sessionId: null, continuing: false, reason: "fresh_working_context" };
    return { sessionId: String(latest.session_id), continuing: false, reason: "small_context" };
  }

  recordSessionContext(sessionId: string, inputTokens: number) {
    if (!Number.isFinite(inputTokens) || inputTokens < 0) return;
    const previous = this.extensionRecord<{ peakInputTokens: number }>("model-session-context", sessionId)?.peakInputTokens || 0;
    if (inputTokens > previous) this.saveExtensionRecord("model-session-context", sessionId, { peakInputTokens: inputTokens });
  }

  conversationSearch(threadId: string, query: string) {
    const rows = this.db.prepare("SELECT id,body,sender_type,created_at FROM messages WHERE thread_id=? AND sender_type IN ('user','bot') ORDER BY created_at DESC,rowid DESC LIMIT 400").all(threadId) as Row[];
    return rankTexts(query, rows.map(row => ({ id: String(row.id), body: String(row.body), sender_type: String(row.sender_type), created_at: String(row.created_at), text: String(row.body) })), 5).map(({ item }) => {
      const body = String(item.body), term = query.trim().split(/\s+/).find(word => body.toLowerCase().includes(word.toLowerCase()));
      const start = term ? Math.max(0, body.toLowerCase().indexOf(term.toLowerCase()) - 300) : 0;
      return { messageId: String(item.id), speaker: String(item.sender_type), at: String(item.created_at), excerpt: body.slice(start, start + 2_400), shortened: start > 0 || body.length > 2_400 };
    });
  }

  createApproval(input: { runId: string; botId: string; kind: Approval["kind"]; reason: string; actionLabel: string; action?: unknown }): Approval {
    const id = randomUUID();
    const run = this.getRun(input.runId);
    this.db.prepare("INSERT INTO approvals (id,run_id,bot_id,kind,reason,action_label,action_json,status,created_at) VALUES (?,?,?,?,?,?,?,'pending',?)").run(
      id, input.runId, input.botId, input.kind, input.reason, input.actionLabel, input.action ? JSON.stringify(input.action) : null, now(),
    );
    this.db.prepare("UPDATE runs SET status='awaiting_approval',approval_reason=?,approval_id=?,task_stage='waiting',progress_at=? WHERE id=?").run(input.reason, id, now(), input.runId);
    if (run?.automationEventId) this.db.prepare("UPDATE automation_events SET status='waiting' WHERE id=?").run(run.automationEventId);
    if (run?.routineId) this.createAutomationAlert({ routineId: run.routineId, runId: run.id, eventId: run.automationEventId, kind: "approval", message: `${this.getRoutine(run.routineId)?.name || "An automation"} is waiting for your approval.` });
    return this.getApproval(id)!;
  }

  private approvalFromRow(row: Row): Approval {
    let requiresSignIn = false;
    try { requiresSignIn = row.kind === "browser" && JSON.parse(String(row.action_json || "null"))?.type === "browser_sign_in"; } catch { /* Invalid actions cannot open a private sign-in panel. */ }
    return {
      id: String(row.id), runId: String(row.run_id), botId: String(row.bot_id), botName: String(row.bot_name), kind: row.kind as Approval["kind"],
      requiresSignIn,
      reason: String(row.reason), actionLabel: String(row.action_label), status: row.status as Approval["status"],
      createdAt: String(row.created_at), decidedAt: row.decided_at ? String(row.decided_at) : null,
    };
  }

  getApproval(id: string): Approval | null {
    const row = this.db.prepare("SELECT a.*,b.name bot_name FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE a.id=?").get(id) as Row | undefined;
    return row ? this.approvalFromRow(row) : null;
  }

  getApprovalAction(id: string): unknown {
    const row = this.db.prepare("SELECT action_json FROM approvals WHERE id=?").get(id) as Row | undefined;
    if (!row?.action_json) return null;
    try { return JSON.parse(String(row.action_json)); } catch { return null; }
  }

  private approvedActionFromRow(row: Row): ApprovedActionReceipt {
    return {
      id: String(row.id), approvalId: String(row.approval_id), runId: String(row.run_id), botId: String(row.bot_id),
      botName: String(row.bot_name), actionType: String(row.action_type), actionLabel: String(row.action_label),
      status: String(row.status) as ApprovedActionReceipt["status"], attemptCount: Number(row.attempt_count || 0),
      resultSummary: row.result_summary ? String(row.result_summary) : null, lastError: row.last_error ? String(row.last_error) : null,
      createdAt: String(row.created_at), startedAt: row.started_at ? String(row.started_at) : null,
      finishedAt: row.finished_at ? String(row.finished_at) : null, reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    };
  }

  private approvedActionSelect(where = "", limit = ""): string {
    return `SELECT aa.*,a.action_label,b.name bot_name FROM approved_actions aa JOIN approvals a ON a.id=aa.approval_id JOIN bots b ON b.id=aa.bot_id ${where} ${limit}`;
  }

  prepareApprovedAction(input: { approvalId: string; runId: string; botId: string; actionType: string; action: unknown }): ApprovedActionReceipt {
    const approval = this.getApproval(input.approvalId);
    if (!approval || approval.runId !== input.runId || approval.botId !== input.botId) throw new Error("That approved action is not linked to this task.");
    const actionDigest = createHash("sha256").update(JSON.stringify(input.action)).digest("hex");
    this.db.prepare(`INSERT OR IGNORE INTO approved_actions (id,approval_id,run_id,bot_id,action_type,action_digest,status,created_at)
      VALUES (?,?,?,?,?,?,'prepared',?)`).run(randomUUID(), input.approvalId, input.runId, input.botId, input.actionType, actionDigest, now());
    const row = this.db.prepare(this.approvedActionSelect("WHERE aa.approval_id=?")).get(input.approvalId) as Row | undefined;
    if (!row || String(row.action_type) !== input.actionType || String(row.action_digest) !== actionDigest) throw new Error("The approved action changed after it was prepared. Review it again.");
    return this.approvedActionFromRow(row);
  }

  getApprovedAction(idOrApprovalId: string): ApprovedActionReceipt | null {
    const row = this.db.prepare(this.approvedActionSelect("WHERE aa.id=? OR aa.approval_id=?")).get(idOrApprovalId, idOrApprovalId) as Row | undefined;
    return row ? this.approvedActionFromRow(row) : null;
  }

  /** A host-recorded account of one job, not a cryptographic signature.
   * Checks retain their host/teammate provenance and unresolved work is
   * explicit; a completed model turn is not proof of a completed outcome. */
  buildRunReceipt(runId: string): RunReceipt | null {
    const run = this.getRun(runId);
    if (!run) return null;
    const job = this.getJobUsage(run.id);
    const jobRunIds = [...new Set(job.runIds)];
    const coordinator = this.getBot(run.botId);
    const team: RunReceiptEntry[] = [{
      botName: run.botName, role: coordinator?.role || null, model: coordinator?.model || null, status: run.status,
      tokens: run.inputTokens + run.outputTokens + run.reasoningTokens, cost: run.cost,
    }];
    for (const child of this.listChildRuns(run.id)) {
      const bot = this.getBot(child.botId);
      team.push({
        botName: child.botName, role: bot?.role || null, model: bot?.model || null, status: child.status,
        tokens: child.inputTokens + child.outputTokens + child.reasoningTokens, cost: child.cost,
      });
    }
    const checks: RunReceiptCheck[] = run.task.verificationChecks.map((check) => ({ label: check.label, passed: check.passed, source: check.source === "host" ? "host" : "teammate", detail: check.detail ?? null }));
    const story = run.activities.filter((activity) => ["tool", "file", "handoff", "message"].includes(activity.kind));
    const workLog = (story.length ? story : run.activities).slice(0, 14).map((activity) => ({ label: activity.label, detail: activity.detail, at: activity.createdAt }));
    const placeholders = jobRunIds.map(() => "?").join(",");
    const artifactRows = jobRunIds.length
      ? this.db.prepare(`SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.source='artifact' AND m.run_id IN (${placeholders}) ORDER BY a.created_at DESC LIMIT 12`).all(...jobRunIds) as Row[]
      : [];
    const artifacts = artifactRows.map((row) => {
      const attachment = this.attachmentFromRow(row);
      return { name: attachment.name, mime: attachment.mime, revision: attachment.revision, url: attachment.url, classification: attachmentClassification(attachment) };
    });
    // S4-U01: retained inputs are shown separately from delivered/partial
    // outputs so a stopped task can say exactly what is still available.
    const inputs = run.attachmentIds.flatMap((id) => {
      const attachment = this.getAttachment(id);
      return attachment ? [{ name: attachment.name, mime: attachment.mime, revision: attachment.revision, url: attachment.url, classification: "internal" as const }] : [];
    });
    // Query this job directly. Filtering the global activity feed lost old
    // actions once other jobs filled its limit, hiding uncertain deliveries.
    const externalActions = (this.db.prepare(this.approvedActionSelect(`WHERE aa.run_id IN (${placeholders || "''"}) ORDER BY aa.created_at ASC,aa.id ASC`)).all(...jobRunIds) as Row[])
      .map((row) => this.approvedActionFromRow(row))
      .map((action) => ({ label: action.actionLabel, status: action.status, detail: action.resultSummary || action.lastError }));
    const uncertainty: string[] = [];
    if (run.status === "failed") uncertainty.push(run.error || "The task failed without a recorded reason.");
    else if (run.status !== "completed") uncertainty.push(`The task is ${run.status}; its outcome is not complete.`);
    if (run.status === "completed") {
      if (run.task.verificationStatus !== "passed") uncertainty.push(`Task verification is ${run.task.verificationStatus}, not passed.`);
      if (!checks.some((check) => check.source === "host" && check.passed)) uncertainty.push("No passed host checks are recorded. A teammate's completion message is not independent verification.");
    }
    for (const check of checks) if (!check.passed) uncertainty.push(`Check failed (${check.source}): ${check.label}. ${check.detail || ""}`.trim());
    for (const child of this.listChildRuns(run.id)) {
      if (child.status !== "completed") uncertainty.push(`${child.botName}: ${child.error || `Consultation is ${child.status}, not completed.`}`);
    }
    const pendingApprovals = this.db.prepare(`SELECT action_label FROM approvals WHERE run_id IN (${placeholders || "''"}) AND status='pending'`).all(...jobRunIds) as Row[];
    for (const approval of pendingApprovals) uncertainty.push(`Awaiting your approval: ${String(approval.action_label)}.`);
    for (const action of externalActions) {
      if (action.status === "uncertain") uncertainty.push(`Uncertain: ${action.label}. ${action.detail || "Check the destination before retrying."}`);
      if (action.status === "failed") uncertainty.push(`Failed: ${action.label}. ${action.detail || ""}`.trim());
      if (action.status === "prepared" || action.status === "running") uncertainty.push(`Not confirmed yet: ${action.label} (${action.status}). Check the destination before retrying.`);
      if (action.status === "confirmed_not_completed") uncertainty.push(`Not completed: ${action.label}. ${action.detail || "The owner confirmed this action did not complete."}`);
    }
    const cost = this.db.prepare(`SELECT COALESCE(SUM(cost),0) AS cost FROM runs WHERE id IN (${placeholders || "''"})`).get(...jobRunIds) as Row;
    const finished = run.finishedAt ? Date.parse(run.finishedAt) : null;
    const started = run.startedAt ? Date.parse(run.startedAt) : null;
    if (run.status === "completed" && run.outcome === "blocked") {
      uncertainty.unshift("This task ended without delivering a result. It must not be read as successful — continue it from here instead of starting over.");
    }
    return {
      runId: run.id, threadId: run.threadId, botName: run.botName,
      goal: run.task.tracked ? run.task.goal.split(" Automation context")[0]?.trim() || null : null,
      deliverable: run.task.tracked ? run.task.deliverable : null,
      status: run.status, outcome: run.outcome ?? null, error: run.error, startedAt: run.startedAt, finishedAt: run.finishedAt,
      durationMs: started !== null && finished !== null && finished > started ? finished - started : null,
      team, checks, workLog, inputs, artifacts, externalActions, uncertainty,
      usage: { tokens: job.totalTokens, cost: Number(cost.cost || 0), runs: jobRunIds.length },
    };
  }

  listApprovedActions(limit = 30): ApprovedActionReceipt[] {
    return (this.db.prepare(this.approvedActionSelect("ORDER BY aa.created_at DESC", "LIMIT ?")).all(Math.max(1, Math.min(limit, 100))) as Row[])
      .map((row) => this.approvedActionFromRow(row));
  }

  listPreparedApprovedActions(): ApprovedActionReceipt[] {
    return (this.db.prepare(this.approvedActionSelect("WHERE aa.status='prepared' AND a.status='approved' ORDER BY aa.created_at ASC")).all() as Row[])
      .map((row) => this.approvedActionFromRow(row));
  }

  claimApprovedAction(approvalId: string): ApprovedActionReceipt | null {
    const result = this.db.prepare(`UPDATE approved_actions SET status='running',attempt_count=attempt_count+1,started_at=?,finished_at=NULL,last_error=NULL
      WHERE approval_id=? AND status='prepared' AND EXISTS (SELECT 1 FROM approvals WHERE id=? AND status='approved')`).run(now(), approvalId, approvalId);
    return result.changes === 1 ? this.getApprovedAction(approvalId) : null;
  }

  completeApprovedAction(approvalId: string, resultSummary: string): ApprovedActionReceipt | null {
    this.db.exec("SAVEPOINT approved_action_result");
    try {
      const result = this.db.prepare("UPDATE approved_actions SET status='completed',result_summary=?,last_error=NULL,finished_at=? WHERE approval_id=? AND status='running'")
        .run(resultSummary.slice(0, 2_000), now(), approvalId);
      const receipt = result.changes === 1 ? this.getApprovedAction(approvalId)! : null;
      const run = receipt ? this.getRun(receipt.runId) : null;
      if (receipt && run && !run.parentRunId) this.addMessage({ threadId: run.threadId, senderType: "system", senderId: null, runId: run.id, kind: "event", eventType: "action_completed", body: `${receipt.botName}: ${/^browser_/.test(receipt.actionType) ? doneLabel(receipt.actionLabel) || receipt.resultSummary : receipt.resultSummary}`, eventData: { title: "Approved action completed", approvalId, actionLabel: receipt.actionLabel, botId: run.botId } });
      this.db.exec("RELEASE approved_action_result");
      return receipt;
    } catch (error) {
      this.db.exec("ROLLBACK TO approved_action_result; RELEASE approved_action_result");
      throw error;
    }
  }

  failApprovedAction(approvalId: string, error: string): ApprovedActionReceipt | null {
    const result = this.db.prepare("UPDATE approved_actions SET status='failed',last_error=?,finished_at=? WHERE approval_id=? AND status='running'")
      .run(error.slice(0, 1_000), now(), approvalId);
    if (result.changes !== 1) return null;
    return this.getApprovedAction(approvalId);
  }

  recoverInterruptedApprovedActions(): ApprovedActionReceipt[] {
    const rows = this.db.prepare(this.approvedActionSelect("WHERE aa.status='running' ORDER BY aa.created_at ASC")).all() as Row[];
    if (!rows.length) return [];
    const recoveredAt = now();
    this.db.prepare("UPDATE approved_actions SET status='uncertain',last_error=?,finished_at=? WHERE status='running'")
      .run("Sidemates restarted while the approved action was in progress. It will not be repeated until you confirm what happened.", recoveredAt);
    return rows.map((row) => this.getApprovedAction(String(row.id))!).filter(Boolean);
  }

  resolveUncertainApprovedAction(id: string, outcome: "completed" | "not_completed"): ApprovedActionReceipt | null {
    const status = outcome === "completed" ? "confirmed_completed" : "confirmed_not_completed";
    const result = this.db.prepare("UPDATE approved_actions SET status=?,result_summary=?,last_error=NULL,reviewed_at=?,finished_at=COALESCE(finished_at,?) WHERE id=? AND status='uncertain'")
      .run(status, outcome === "completed" ? "You confirmed this action completed." : "You confirmed this action did not complete.", now(), now(), id);
    return result.changes === 1 ? this.getApprovedAction(id) : null;
  }

  /** R02/R03 input-ownership epoch per teammate. Stop, takeover and
   * sign-in handoff bump the epoch; in-flight action proposals admitted
   * under an older epoch are refused dispatch. Stored durably so the
   * revocation survives restarts; defaults to 0 (never revoked). */
  botInputEpoch(botId: string): number {
    const record = this.extensionRecord<{ epoch: number }>("input-epoch", botId);
    return record?.epoch ?? 0;
  }

  revokeBotInput(botId: string): number {
    const next = this.botInputEpoch(botId) + 1;
    this.saveExtensionRecord("input-epoch", botId, { epoch: next });
    return next;
  }

  /** R02 durable action journal (renderer-independent companion to
   * approved_actions). Every browser/visual/native dispatch admits here
   * first: one admitted mutation can never fork a second version through
   * another driver, and an uncertain effect requires owner reconciliation —
   * never readmission. Rows intentionally carry no foreign keys: the journal
   * is the recovery record of last resort and must survive referenced-row
   * deletion. Transitions are enforced by conditional updates (changes===1
   * wins), so concurrent processes cannot both dispatch the same action. */
  journalActionPropose(input: {
    actionId: string; runId: string; botId: string; surface: string;
    surfaceIdentity: string; ownershipEpoch: string; target: string;
    payloadDigest: string; reviewDigest?: string | null; account?: string;
    mutationKey?: string | null; effectDigest?: string | null;
    detail?: string | null;
  }): ActionJournalRecord {
    const at = now();
    // Finding G1: a mutation key is bound to one logical effect per
    // run/teammate at first admission. The same key reused for a different
    // effect — or a key owned by another run/teammate — refuses here,
    // before any row is written. Retries of the same effect keep the same
    // key AND the same effect digest, so they pass this check and meet the
    // mutation fence instead.
    if (input.mutationKey) {
      const foreign = this.db.prepare(
        "SELECT action_id FROM action_journal WHERE mutation_key=? AND (run_id<>? OR bot_id<>?) LIMIT 1",
      ).get(input.mutationKey, input.runId, input.botId) as Row | undefined;
      if (foreign) throw new Error("That mutation identity belongs to a different task or teammate.");
      const sameScope = this.db.prepare(
        "SELECT action_id,effect_digest FROM action_journal WHERE mutation_key=? AND run_id=? AND bot_id=?",
      ).all(input.mutationKey, input.runId, input.botId) as Row[];
      if (sameScope.some((row) => String(row.effect_digest ?? "") !== String(input.effectDigest ?? ""))) {
        throw new Error("That mutation identity is already bound to a different effect. Use a new identity for new work.");
      }
    }
    try {
      this.db.prepare(`INSERT INTO action_journal
        (action_id,run_id,bot_id,surface,surface_identity,ownership_epoch,target,payload_digest,review_digest,account,mutation_key,effect_digest,stage,detail,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.actionId, input.runId, input.botId, input.surface, input.surfaceIdentity,
        input.ownershipEpoch, input.target, input.payloadDigest, input.reviewDigest ?? null,
        input.account ?? "", input.mutationKey ?? null, input.effectDigest ?? null, "proposed", input.detail ?? null, at, at,
      );
      return this.journalActionGet(input.actionId)!;
    } catch {
      const existing = this.journalActionGet(input.actionId);
      if (!existing) throw new Error("That action is already being processed. Check its result instead of sending it again.");
      // Reusing an action ID with a different identity is a conflict, never
      // a silent adoption of the new payload/bot/run.
      const same =
        existing.runId === input.runId &&
        existing.botId === input.botId &&
        existing.surface === input.surface &&
        existing.surfaceIdentity === input.surfaceIdentity &&
        existing.ownershipEpoch === input.ownershipEpoch &&
        existing.target === input.target &&
        existing.payloadDigest === input.payloadDigest &&
        (existing.reviewDigest ?? null) === (input.reviewDigest ?? null) &&
        (existing.account ?? "") === (input.account ?? "") &&
        (existing.mutationKey ?? null) === (input.mutationKey ?? null) &&
        (existing.effectDigest ?? null) === (input.effectDigest ?? null);
      if (!same) throw new Error("That action ID is already bound to a different run, teammate, target or payload. Use a new action for new work.");
      return existing;
    }
  }

  journalActionGet(actionId: string): ActionJournalRecord | null {
    const row = this.db.prepare("SELECT * FROM action_journal WHERE action_id=?").get(actionId) as Row | undefined;
    return row ? this.journalActionFromRow(row) : null;
  }

  private journalActionFromRow(row: Row): ActionJournalRecord {
    return {
      actionId: String(row.action_id),
      runId: String(row.run_id),
      botId: String(row.bot_id),
      surface: String(row.surface),
      surfaceIdentity: String(row.surface_identity),
      ownershipEpoch: String(row.ownership_epoch),
      target: String(row.target),
      payloadDigest: String(row.payload_digest),
      reviewDigest: row.review_digest == null ? null : String(row.review_digest),
      account: String(row.account ?? ""),
      mutationKey: row.mutation_key == null ? null : String(row.mutation_key),
      effectDigest: row.effect_digest == null ? null : String(row.effect_digest),
      stage: String(row.stage) as ActionJournalRecord["stage"],
      detail: row.detail == null ? null : String(row.detail),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** Adds a card. Returns null when an active card for the same source
   * already exists (the same email never makes two cards). */
  queueItemInsert(input: { kind: string; title: string; why: string; sourceKey: string; botId: string | null; runId: string | null; action: Record<string, unknown>; preview: string; expiresAt: string; pattern?: string | null; meta?: Record<string, string> | null }): QueueItemRecord | null {
    const id = `q-${randomUUID().slice(0, 12)}`;
    try {
      this.db.prepare(
        "INSERT INTO queue_items (id,kind,status,title,why,source_key,bot_id,run_id,action_json,preview,created_at,expires_at,pattern,meta_json) VALUES (?,?,'ready',?,?,?,?,?,?,?,?,?,?,?)",
      ).run(id, input.kind, input.title, input.why, input.sourceKey, input.botId, input.runId, JSON.stringify(input.action), input.preview, now(), input.expiresAt, input.pattern ?? null, input.meta ? JSON.stringify(input.meta) : null);
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return null;
      throw error;
    }
    return this.queueItemGet(id);
  }

  queueItemGet(id: string): QueueItemRecord | null {
    const row = this.db.prepare("SELECT * FROM queue_items WHERE id=?").get(id) as Row | undefined;
    return row ? this.queueItemFromRow(row) : null;
  }

  /** Newest first. Pass the statuses to include. */
  queueItemsList(statuses: QueueItemStatus[], limit = 50): QueueItemRecord[] {
    if (!statuses.length) return [];
    const marks = statuses.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM queue_items WHERE status IN (${marks}) ORDER BY created_at DESC LIMIT ?`).all(...statuses, limit) as Row[];
    return rows.map((row) => this.queueItemFromRow(row));
  }

  /** The latest card for a source in any state, so a card someone skipped or undid is not offered again. */
  queueItemFindBySource(kind: string, sourceKey: string): QueueItemRecord | null {
    const row = this.db.prepare("SELECT * FROM queue_items WHERE kind=? AND source_key=? ORDER BY created_at DESC LIMIT 1").get(kind, sourceKey) as Row | undefined;
    return row ? this.queueItemFromRow(row) : null;
  }

  /** Cards made since a moment that needed a person's look. Things a rule did by itself do not crowd the list. */
  queueItemsCreatedSince(iso: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE created_at>=? AND (decided_by IS NULL OR decided_by NOT LIKE 'rule:%')").get(iso) as Row).n);
  }

  /** Moves one card between states. `from` makes the change conditional, so
   * two quick taps cannot approve the same card twice. */
  queueItemTransition(id: string, from: QueueItemStatus[], patch: { status: QueueItemStatus; result?: Record<string, unknown> | null; error?: string | null; decidedBy?: string | null; undone?: boolean }): QueueItemRecord | null {
    const marks = from.map(() => "?").join(",");
    const stamp = now();
    const changed = this.db.prepare(
      `UPDATE queue_items SET status=?, result_json=COALESCE(?, result_json), error=?, decided_at=COALESCE(decided_at, ?), decided_by=COALESCE(?, decided_by), undone_at=? WHERE id=? AND status IN (${marks})`,
    ).run(patch.status, patch.result === undefined ? null : JSON.stringify(patch.result), patch.error ?? null, stamp, patch.decidedBy ?? null, patch.undone ? stamp : null, id, ...from).changes;
    return changed === 1 ? this.queueItemGet(id) : null;
  }

  /** Cards nobody decided in time stop being offered. Returns how many. */
  queueItemsExpire(beforeIso: string): number {
    return Number(this.db.prepare("UPDATE queue_items SET status='expired' WHERE status='ready' AND expires_at<?").run(beforeIso).changes);
  }

  private queueItemFromRow(row: Row): QueueItemRecord {
    return {
      id: String(row.id),
      kind: String(row.kind),
      status: String(row.status) as QueueItemStatus,
      title: String(row.title),
      why: String(row.why),
      sourceKey: String(row.source_key),
      botId: row.bot_id == null ? null : String(row.bot_id),
      runId: row.run_id == null ? null : String(row.run_id),
      action: JSON.parse(String(row.action_json)) as Record<string, unknown>,
      preview: String(row.preview),
      result: row.result_json == null ? null : JSON.parse(String(row.result_json)) as Record<string, unknown>,
      error: row.error == null ? null : String(row.error),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      decidedAt: row.decided_at == null ? null : String(row.decided_at),
      decidedBy: row.decided_by == null ? null : String(row.decided_by),
      undoneAt: row.undone_at == null ? null : String(row.undone_at),
      pattern: row.pattern == null ? null : String(row.pattern),
      meta: row.meta_json == null ? null : JSON.parse(String(row.meta_json)) as Record<string, string>,
    };
  }

  /** How many times in a row a person approved this pattern, newest first, with nothing in between
   * that they skipped or undid. Cards a rule ran by itself do not count. */
  queuePatternStreak(pattern: string): number {
    const rows = this.db.prepare(
      "SELECT status FROM queue_items WHERE pattern=? AND ((status='done' AND decided_by='person') OR status IN ('skipped','undone')) ORDER BY COALESCE(decided_at, created_at) DESC, created_at DESC LIMIT 50",
    ).all(pattern) as Row[];
    let streak = 0;
    for (const row of rows) { if (String(row.status) !== "done") break; streak++; }
    return streak;
  }

  /** Patterns a person has approved at least once, with their kind: the candidates for an offer. */
  queueApprovedPatterns(): { pattern: string; kind: string }[] {
    return (this.db.prepare("SELECT DISTINCT pattern, kind FROM queue_items WHERE pattern IS NOT NULL AND status='done' AND decided_by='person'").all() as Row[])
      .map((row) => ({ pattern: String(row.pattern), kind: String(row.kind) }));
  }

  /** Cards a rule ran by itself since a moment, newest first (the weekly "what I did alone"). */
  queueItemsDecidedByRulesSince(iso: string): QueueItemRecord[] {
    return (this.db.prepare("SELECT * FROM queue_items WHERE decided_by LIKE 'rule:%' AND status IN ('done','undone') AND decided_at>=? ORDER BY decided_at DESC LIMIT 200").all(iso) as Row[]).map((row) => this.queueItemFromRow(row));
  }

  /** Files a person approved and nobody undid, filed within a time range (oldest first): the receipts ledger. */
  queueFilesFiledBetween(startIso: string, endIso: string): QueueItemRecord[] {
    return (this.db.prepare("SELECT * FROM queue_items WHERE kind='file_attachment' AND status='done' AND decided_at>=? AND decided_at<? ORDER BY decided_at ASC LIMIT 2000").all(startIso, endIso) as Row[]).map((row) => this.queueItemFromRow(row));
  }

  /** Every month (local time) that has at least one filed file, newest first. */
  queueFileMonths(): string[] {
    const stamps = (this.db.prepare("SELECT decided_at FROM queue_items WHERE kind='file_attachment' AND status='done' AND decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT 5000").all() as Row[]).map((row) => new Date(String(row.decided_at)));
    return [...new Set(stamps.map((date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`))];
  }

  queueRuleList(): QueueRuleRecord[] {
    return (this.db.prepare("SELECT * FROM queue_rules ORDER BY created_at DESC").all() as Row[]).map((row) => this.queueRuleFromRow(row));
  }

  queueRuleGet(id: string): QueueRuleRecord | null {
    const row = this.db.prepare("SELECT * FROM queue_rules WHERE id=?").get(id) as Row | undefined;
    return row ? this.queueRuleFromRow(row) : null;
  }

  queueRuleFindByPattern(pattern: string): QueueRuleRecord | null {
    const row = this.db.prepare("SELECT * FROM queue_rules WHERE pattern=?").get(pattern) as Row | undefined;
    return row ? this.queueRuleFromRow(row) : null;
  }

  /** Returns null when a rule (in any state) already exists for the pattern. */
  queueRuleInsert(kind: string, pattern: string, status: QueueRuleStatus): QueueRuleRecord | null {
    const id = `qr-${randomUUID().slice(0, 12)}`;
    const stamp = now();
    try {
      this.db.prepare("INSERT INTO queue_rules (id,kind,pattern,status,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, kind, pattern, status, stamp, stamp);
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return null;
      throw error;
    }
    return this.queueRuleGet(id);
  }

  /** Changes a rule's state only from the states given, so a late tap cannot undo a newer decision. */
  queueRuleTransition(id: string, from: QueueRuleStatus[], status: QueueRuleStatus, pausedReason: string | null = null): QueueRuleRecord | null {
    const marks = from.map(() => "?").join(",");
    const changed = this.db.prepare(`UPDATE queue_rules SET status=?, paused_reason=?, updated_at=? WHERE id=? AND status IN (${marks})`).run(status, status === "paused" ? pausedReason : null, now(), id, ...from).changes;
    return changed === 1 ? this.queueRuleGet(id) : null;
  }

  queueRuleRecordUse(id: string) {
    const stamp = now();
    this.db.prepare("UPDATE queue_rules SET uses=uses+1, last_used_at=?, updated_at=? WHERE id=?").run(stamp, stamp, id);
  }

  private queueRuleFromRow(row: Row): QueueRuleRecord {
    return {
      id: String(row.id), kind: String(row.kind), pattern: String(row.pattern), status: String(row.status) as QueueRuleStatus,
      pausedReason: row.paused_reason == null ? null : String(row.paused_reason), uses: Number(row.uses),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), lastUsedAt: row.last_used_at == null ? null : String(row.last_used_at),
    };
  }

  /** Admit exactly once from a pre-dispatch stage. Refuses verified,
   * failed, already-admitted/in-flight and uncertain actions: uncertainty
   * requires reconciliation, never readmission through another driver. */
  journalActionAdmit(actionId: string): boolean {
    const result = this.db.prepare(
      "UPDATE action_journal SET stage='admitted',updated_at=? WHERE action_id=? AND stage IN ('proposed','validated','awaiting_review')",
    ).run(now(), actionId);
    return result.changes === 1;
  }

  /** Atomically claim a reviewed effect, regardless of which fresh mutation
   * token the caller obtained. SQLite serializes the conditional update, so
   * two approvals or processes cannot both pass a read-then-write fence. */
  journalActionAdmitEffectOnce(actionId: string): boolean {
    const result = this.db.prepare(`
      UPDATE action_journal SET stage='admitted',updated_at=?
      WHERE action_id=? AND stage IN ('proposed','validated','awaiting_review')
        AND effect_digest IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM action_journal prior
          WHERE prior.run_id=action_journal.run_id
            AND prior.bot_id=action_journal.bot_id
            AND prior.effect_digest=action_journal.effect_digest
            AND prior.action_id<>action_journal.action_id
            AND prior.stage IN ('admitted','dispatch_started','effect_observed','outcome_uncertain','verified')
        )
    `).run(now(), actionId);
    return result.changes === 1;
  }

  journalActionFindByEffect(effectDigest: string, runId: string, botId: string): ActionJournalRecord[] {
    return (this.db.prepare("SELECT * FROM action_journal WHERE effect_digest=? AND run_id=? AND bot_id=? AND stage IN ('admitted','dispatch_started','effect_observed','outcome_uncertain','verified') ORDER BY created_at ASC").all(effectDigest, runId, botId) as Row[])
      .map((row) => this.journalActionFromRow(row));
  }

  /** Enforced stage machine. outcome_uncertain is terminal here: leaving it
   * requires journalActionReconcile with owner-checked evidence. */
  journalActionTransition(actionId: string, stage: ActionJournalRecord["stage"], detail: string | null = null): ActionJournalRecord | null {
    const allowed: Record<ActionJournalRecord["stage"], ActionJournalRecord["stage"][]> = {
      proposed: ["validated", "failed_before_effect"],
      validated: ["awaiting_review", "admitted", "failed_before_effect"],
      awaiting_review: ["admitted", "failed_before_effect"],
      admitted: ["dispatch_started", "failed_before_effect"],
      dispatch_started: ["effect_observed", "failed_before_effect", "outcome_uncertain"],
      effect_observed: ["verified", "failed_before_effect", "outcome_uncertain"],
      verified: [],
      failed_before_effect: [],
      outcome_uncertain: [],
    };
    const current = this.journalActionGet(actionId);
    if (!current || !allowed[current.stage].includes(stage)) return null;
    this.db.prepare("UPDATE action_journal SET stage=?,detail=COALESCE(?,detail),updated_at=? WHERE action_id=? AND stage=?")
      .run(stage, detail, now(), actionId, current.stage);
    return this.journalActionGet(actionId);
  }

  /** Owner reconciliation of an uncertain effect after an allowed read-back.
   * Never returns the action to an admittable stage: a confirmed effect is
   * verified without re-dispatch; a confirmed miss is failed and any still-
   * needed work requires a new action with a new identity. */
  journalActionReconcile(actionId: string, outcome: "verified" | "failed_before_effect", evidence: string): ActionJournalRecord | null {
    const result = this.db.prepare(
      "UPDATE action_journal SET stage=?,detail=?,updated_at=? WHERE action_id=? AND stage='outcome_uncertain'",
    ).run(outcome, evidence.slice(0, 1_000), now(), actionId);
    return result.changes === 1 ? this.journalActionGet(actionId) : null;
  }

  listUncertainJournalActions(): ActionJournalRecord[] {
    return (this.db.prepare("SELECT * FROM action_journal WHERE stage='outcome_uncertain' OR stage='dispatch_started' OR stage='effect_observed' ORDER BY updated_at ASC").all() as Row[])
      .map((row) => this.journalActionFromRow(row));
  }

  /** Finding A: every journal row carrying one logical mutation identity,
   * for one run and teammate. The mutation fence consults these across
   * observation IDs, renderers, attempts and restarts. */
  journalActionFindByMutation(mutationKey: string, runId: string, botId: string): ActionJournalRecord[] {
    return (this.db.prepare("SELECT * FROM action_journal WHERE mutation_key=? AND run_id=? AND bot_id=? ORDER BY created_at ASC").all(mutationKey, runId, botId) as Row[])
      .map((row) => this.journalActionFromRow(row));
  }

  /** Host-issued mutation identity. The host mints an opaque random token
   * with the canonical effect digest bound AT MINT TIME (plus the approval
   * for reviewed consequential work). Executors verify the exact
   * token/run/teammate/effect — and the approval when approval-backed — so
   * a caller can neither invent an ID nor repurpose a minted one for a
   * different effect to dodge the fence. Model-loop exposure must mint at
   * review time and hand the model only the opaque ID. */
  mintMutationToken(runId: string, botId: string, effectDigest: string, approvalId?: string | null): string {
    const run = this.getRun(runId);
    if (!run || run.botId !== botId) throw new Error("Mutation identities are minted per task and teammate.");
    if (!effectDigest || effectDigest.length !== 64) throw new Error("Mutation identities are minted for one exact effect.");
    if (approvalId != null) {
      const approval = this.getApproval(approvalId);
      if (!approval || approval.runId !== runId || approval.botId !== botId) throw new Error("Mutation identities bind approvals of the same task and teammate.");
    }
    const token = `mut_${randomBytes(16).toString("hex")}`;
    this.db.prepare("INSERT INTO mutation_tokens (token,run_id,bot_id,effect_digest,approval_id,created_at) VALUES (?,?,?,?,?,?)")
      .run(token, runId, botId, effectDigest, approvalId ?? null, now());
    return token;
  }

  /** Exact-match verification for a minted token: token, run, teammate,
   * pre-bound effect, and approval when approval-backed must ALL match.
   * Anything else — unknown token, foreign run/teammate, repurposed
   * effect, wrong approval, or a legacy row without a bound effect —
   * refuses. Fail-closed, no row is written here. */
  checkMutationToken(token: string, runId: string, botId: string, effectDigest: string, approvalId?: string | null): void {
    const row = this.db.prepare("SELECT token,run_id,bot_id,effect_digest,approval_id FROM mutation_tokens WHERE token=?").get(token) as Row | undefined;
    if (!row) throw new Error("Unknown mutation identity for this task and teammate. The host must issue it at review time — invented IDs are refused.");
    if (String(row.run_id) !== runId || String(row.bot_id) !== botId) {
      throw new Error("Unknown mutation identity for this task and teammate. The host must issue it at review time — invented IDs are refused.");
    }
    if (row.effect_digest == null || String(row.effect_digest) !== effectDigest) {
      if (row.effect_digest == null) throw new Error("That mutation identity predates effect binding. Mint a new identity for new work.");
      throw new Error("That mutation identity is already bound to a different effect. Use a new identity for new work.");
    }
    const boundApproval = row.approval_id == null ? null : String(row.approval_id);
    if (boundApproval !== null && (approvalId ?? null) !== boundApproval) {
      throw new Error("That mutation identity is bound to a different approval. Use the reviewed identity for reviewed work.");
    }
  }

  /** True only for a host-minted token bound to this run/teammate. */
  hasMutationToken(token: string, runId: string, botId: string): boolean {
    const row = this.db.prepare("SELECT token FROM mutation_tokens WHERE token=? AND run_id=? AND bot_id=?").get(token, runId, botId) as Row | undefined;
    return Boolean(row);
  }

  /** Startup recovery mirroring recoverInterruptedApprovedActions: anything
   * that may have dispatched but never observed an outcome becomes
   * uncertain. It will not be repeated until the owner reconciles it. */
  recoverInterruptedJournalActions(): ActionJournalRecord[] {
    const rows = this.db.prepare("SELECT * FROM action_journal WHERE stage IN ('dispatch_started','effect_observed') ORDER BY updated_at ASC").all() as Row[];
    if (!rows.length) return [];
    const at = now();
    this.db.prepare("UPDATE action_journal SET stage='outcome_uncertain',detail=?,updated_at=? WHERE stage IN ('dispatch_started','effect_observed')")
      .run("Sidemates restarted while the action may have taken effect. It will not be repeated until you confirm what happened.", at);
    return rows.map((row) => this.journalActionGet(String(row.action_id))!).filter(Boolean);
  }

  listApprovals(): Approval[] {
    return (this.db.prepare("SELECT a.*,b.name bot_name FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE a.status='pending' ORDER BY a.created_at ASC").all() as Row[]).map((row) => this.approvalFromRow(row));
  }

  /** Every review for one run, decided or not (P07a). Attention measurement
   * must see approved and denied reviews too, not just pending ones. */
  listRunApprovals(runId: string): Approval[] {
    return (this.db.prepare("SELECT a.*,b.name bot_name FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE a.run_id=? ORDER BY a.created_at ASC").all(runId) as Row[]).map((row) => this.approvalFromRow(row));
  }

  /** A declined mid-task action (terminal, browser or connector) lets the
   * teammate finish without it and say what is left, instead of ending the
   * whole task silently. Declining a task start, Stop, and repeated declines
   * in one task still cancel. */
  decideApproval(id: string, decision: "approved" | "denied", options: { continueAfterDecline?: boolean } = {}): Approval | null {
    const approval = this.getApproval(id);
    if (!approval || approval.status !== "pending" || approval.kind === "budget") return null;
    const result = this.db.prepare("UPDATE approvals SET status=?,decided_at=? WHERE id=? AND status='pending'").run(decision, now(), id);
    if (result.changes !== 1) return null;
    if (decision === "approved") {
      this.updateRun(approval.runId, { status: "queued", approvalReason: null, taskStage: "working", progressAt: now() });
      this.db.prepare("UPDATE automation_alerts SET resolved_at=? WHERE run_id=? AND kind='approval' AND resolved_at IS NULL").run(now(), approval.runId);
    }
    else {
      this.db.prepare("DELETE FROM approved_actions WHERE approval_id=? AND status='prepared'").run(id);
      const run = this.getRun(approval.runId);
      const declines = Number((this.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id=? AND status='denied'").get(approval.runId) as { n: number }).n);
      if (options.continueAfterDecline && approval.kind !== "prompt" && run && !["completed", "failed", "cancelled"].includes(run.status) && declines <= MAX_DECLINES_BEFORE_STOP) {
        const original = this.extensionRecord<{ prompt: string }>("declined-original-request", run.id)?.prompt ?? run.prompt;
        this.saveExtensionRecord("declined-original-request", run.id, { prompt: original });
        this.setRunPrompt(run.id, declinedActionPrompt(approval.actionLabel, original));
        this.updateRun(run.id, { status: "queued", approvalReason: null, taskStage: "working", finishedAt: null, error: null, progressAt: now() });
        this.db.prepare("UPDATE automation_alerts SET resolved_at=? WHERE run_id=? AND kind='approval' AND resolved_at IS NULL").run(now(), run.id);
        this.addActivity({ runId: run.id, botId: run.botId, kind: "status", label: "Declined by you", detail: `${run.botName} will finish without it and tell you what is left.` });
      } else {
        this.updateRun(approval.runId, { status: "cancelled", finishedAt: now(), taskStage: "blocked", progressAt: now() });
        this.finishRunTask(approval.runId, "cancelled");
      }
    }
    return this.getApproval(id);
  }

  cancelRun(id: string): Run | null {
    const run = this.getRun(id);
    if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return null;
    const tokens = this.taskTokenPolicy(id);
    if (tokens.pendingApprovalId) {
      this.decideTaskTokens(tokens.pendingApprovalId, "denied", { maxTokens: 0, maxJobTokens: 0 });
      return this.getRun(id);
    }
    const approval = run.approvalId ? this.getApproval(run.approvalId) : null;
    if (approval?.status === "pending") this.decideApproval(approval.id, "denied");
    else {
      this.updateRun(run.id, { status: "cancelled", finishedAt: now(), taskStage: "blocked" });
      this.finishRunTask(run.id, "cancelled");
    }
    return this.getRun(id);
  }

  listProviders(): ProviderInstance[] {
    return (this.db.prepare("SELECT * FROM provider_instances ORDER BY created_at ASC").all() as Row[]).map((row) => ({
      id: String(row.id), ownerId: String(row.owner_id), provider: row.provider as ProviderInstance["provider"], name: String(row.name),
      authMode: row.auth_mode as ProviderInstance["authMode"], envName: row.env_name ? String(row.env_name) : null,
      runtime: (row.runtime || "opencode") as ProviderInstance["runtime"], hasSecret: Boolean(row.secret_ciphertext),
      apiConfig: row.api_config_json ? JSON.parse(String(row.api_config_json)) : null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  getProvider(id: string): ProviderInstance | null {
    return this.listProviders().find((provider) => provider.id === id) || null;
  }

  providerForBot(botId: string): ProviderInstance | null {
    const bot = this.getBot(botId);
    return bot?.providerInstanceId ? this.getProvider(bot.providerInstanceId) : null;
  }

  // Explicit first-run choice only fills unconfigured teammates. Existing
  // assignments must never change as a side effect of discovering an account.
  chooseInitialProvider(providerId: string, model: string): number {
    const provider = this.getProvider(providerId);
    if (!provider || !modelBelongsToConnection(model, provider)) throw new Error("Choose a model from your selected AI connection.");
    return Number(this.db.prepare("UPDATE bots SET provider_instance_id=?, model=? WHERE provider_instance_id IS NULL AND model=''").run(providerId, model).changes);
  }

  upsertProvider(rawInput: ProviderInput): ProviderInstance {
    const input = providerInput.parse(rawInput);
    const id = input.id || randomUUID();
    const existing = this.db.prepare("SELECT * FROM provider_instances WHERE id=?").get(id) as Row | undefined;
    const encrypted = input.secret ? this.vault.encrypt(input.secret) : existing?.secret_ciphertext || null;
    const at = now();
    const apiConfig = input.apiConfig === undefined ? existing?.api_config_json || null : input.apiConfig ? JSON.stringify(input.apiConfig) : null;
    if (apiConfig && !encrypted && !isLocalModelUrl(JSON.parse(String(apiConfig)).baseUrl)) throw new Error("Add an API key for this hosted provider.");
    this.db.prepare(`INSERT INTO provider_instances (id,owner_id,provider,name,auth_mode,runtime,env_name,secret_ciphertext,created_at,updated_at,api_config_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,auth_mode=excluded.auth_mode,runtime=excluded.runtime,env_name=excluded.env_name,secret_ciphertext=excluded.secret_ciphertext,updated_at=excluded.updated_at,api_config_json=excluded.api_config_json`).run(
      id, DEFAULT_OWNER, input.provider || "custom", input.name, input.authMode, input.runtime || "opencode", apiConfig ? MODEL_KEY_ENV : input.envName || null, encrypted, existing?.created_at || at, at, apiConfig,
    );
    return this.listProviders().find((provider) => provider.id === id)!;
  }

  deleteAPIProvider(id: string): "deleted" | "missing" | "assigned" | "protected" {
    const provider = this.getProvider(id);
    if (!provider) return "missing";
    if (provider.authMode !== "api_key" || id.startsWith("local-")) return "protected";
    const assigned = this.db.prepare("SELECT 1 FROM bots WHERE provider_instance_id=? LIMIT 1").get(id);
    if (assigned) return "assigned";
    this.db.prepare("DELETE FROM provider_instances WHERE id=?").run(id);
    return "deleted";
  }

  providerEnvironment(botId: string): Record<string, string> {
    const provider = this.providerForBot(botId);
    return provider ? this.providerEnvironmentById(provider.id) : {};
  }

  providerEnvironmentById(providerId: string): Record<string, string> {
    const provider = this.getProvider(providerId);
    if (!provider || provider.authMode !== "api_key") return {};
    const row = this.db.prepare("SELECT secret_ciphertext FROM provider_instances WHERE id=?").get(providerId) as Row;
    return apiRuntimeEnvironment(provider, row.secret_ciphertext ? this.vault.decrypt(String(row.secret_ciphertext)) : null);
  }

  /** Decrypted key for server-side calls to a key-based provider (embeddings).
   * Never logged or returned to models; subscription logins have none. */
  providerApiSecret(providerId: string): string | null {
    const provider = this.getProvider(providerId);
    if (!provider || provider.authMode !== "api_key") return null;
    const row = this.db.prepare("SELECT secret_ciphertext FROM provider_instances WHERE id=?").get(providerId) as Row | undefined;
    return row?.secret_ciphertext ? this.vault.decrypt(String(row.secret_ciphertext)) : null;
  }

  private connectorFromRow(row: Row): ConnectorConnection {
    let scopes: string[] = [];
    try { scopes = JSON.parse(String(row.scopes_json || "[]")) as string[]; } catch { /* keep an empty scope list */ }
    return {
      id: String(row.id), ownerId: String(row.owner_id), kind: row.kind as ConnectorConnection["kind"], name: String(row.name),
      configured: Boolean(row.client_id), connected: row.status === "connected" && (row.kind === "github_cli" || Boolean(row.credentials_ciphertext || row.access_token_ciphertext || row.refresh_token_ciphertext)),
      accountEmail: row.account_email ? String(row.account_email) : null, scopes, status: row.status as ConnectorConnection["status"],
      lastError: row.last_error ? String(row.last_error) : null, lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  listConnectors(): ConnectorConnection[] {
    return (this.db.prepare("SELECT * FROM connectors ORDER BY created_at ASC").all() as Row[]).map((row) => this.connectorFromRow(row));
  }

  getConnector(id: string): ConnectorConnection | null {
    const row = this.db.prepare("SELECT * FROM connectors WHERE id=?").get(id) as Row | undefined;
    return row ? this.connectorFromRow(row) : null;
  }

  connectorEventConfig(id: "slack" | "notion"): { pathToken: string; secretConfigured: boolean; verifiedAt: string | null } {
    let row = this.db.prepare("SELECT event_path_ciphertext,event_secret_ciphertext,event_verified_at FROM connectors WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error(`Connect ${id === "slack" ? "Slack" : "Notion"} before setting up events.`);
    if (!row.event_path_ciphertext) {
      const pathToken = randomBytes(24).toString("base64url");
      this.db.prepare("UPDATE connectors SET event_path_ciphertext=?,updated_at=? WHERE id=?").run(this.vault.encrypt(pathToken), now(), id);
      row = this.db.prepare("SELECT event_path_ciphertext,event_secret_ciphertext,event_verified_at FROM connectors WHERE id=?").get(id) as Row;
    }
    return {
      pathToken: this.vault.decrypt(String(row.event_path_ciphertext)),
      secretConfigured: Boolean(row.event_secret_ciphertext),
      verifiedAt: row.event_verified_at ? String(row.event_verified_at) : null,
    };
  }

  connectorEventSecret(id: "slack" | "notion"): string | null {
    const row = this.db.prepare("SELECT event_secret_ciphertext FROM connectors WHERE id=?").get(id) as Row | undefined;
    return row?.event_secret_ciphertext ? this.vault.decrypt(String(row.event_secret_ciphertext)) : null;
  }

  configureConnectorEventSecret(id: "slack" | "notion", secret: string) {
    if (!this.getConnector(id)) throw new Error(`Connect ${id === "slack" ? "Slack" : "Notion"} first.`);
    const current = this.connectorEventSecret(id);
    this.db.prepare("UPDATE connectors SET event_secret_ciphertext=?,event_verified_at=CASE WHEN ? THEN event_verified_at ELSE NULL END,updated_at=? WHERE id=?").run(this.vault.encrypt(secret), current === secret ? 1 : 0, now(), id);
    return this.connectorEventConfig(id);
  }

  markConnectorEventsVerified(id: "slack" | "notion", secret?: string) {
    if (secret) this.db.prepare("UPDATE connectors SET event_secret_ciphertext=?,event_verified_at=?,updated_at=? WHERE id=?").run(this.vault.encrypt(secret), now(), now(), id);
    else this.db.prepare("UPDATE connectors SET event_verified_at=?,updated_at=? WHERE id=?").run(now(), now(), id);
    return this.connectorEventConfig(id);
  }

  rotateConnectorEventPath(id: "slack" | "notion") {
    const pathToken = randomBytes(24).toString("base64url");
    this.db.prepare("UPDATE connectors SET event_path_ciphertext=?,event_secret_ciphertext=NULL,event_verified_at=NULL,updated_at=? WHERE id=?").run(this.vault.encrypt(pathToken), now(), id);
    return this.connectorEventConfig(id);
  }

  configureOAuthConnector(input: { id: "slack" | "notion" | "todoist" | "dropbox"; kind: "slack_oauth" | "notion_oauth" | "todoist_oauth" | "dropbox_oauth"; name: string; clientId: string; clientSecret: string }): ConnectorConnection {
    const existing = this.db.prepare("SELECT * FROM connectors WHERE id=?").get(input.id) as Row | undefined;
    const changedClient = Boolean(existing?.client_id && String(existing.client_id) !== input.clientId);
    const at = now(), encryptedSecret = this.vault.encrypt(input.clientSecret || PUBLIC_OAUTH_CLIENT);
    const status = changedClient || !existing?.credentials_ciphertext ? "configured" : String(existing.status || "configured");
    this.db.prepare(`INSERT INTO connectors
      (id,owner_id,kind,name,client_id,client_secret_ciphertext,credentials_ciphertext,scopes_json,account_email,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,NULL,'[]',NULL,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,client_id=excluded.client_id,client_secret_ciphertext=excluded.client_secret_ciphertext,
      credentials_ciphertext=CASE WHEN ? THEN NULL ELSE connectors.credentials_ciphertext END,
      scopes_json=CASE WHEN ? THEN '[]' ELSE connectors.scopes_json END,account_email=CASE WHEN ? THEN NULL ELSE connectors.account_email END,
      status=?,last_error=NULL,updated_at=excluded.updated_at`).run(
      input.id, DEFAULT_OWNER, input.kind, input.name, input.clientId, encryptedSecret, status, existing?.created_at || at, at,
      changedClient ? 1 : 0, changedClient ? 1 : 0, changedClient ? 1 : 0, status,
    );
    if (changedClient) this.db.prepare("UPDATE connectors SET authorization_version=authorization_version+1 WHERE id=?").run(input.id);
    return this.getConnector(input.id)!;
  }

  oauthConnectorCredentials<T extends Record<string, unknown> = Record<string, unknown>>(id: "slack" | "notion" | "todoist" | "dropbox"): { clientId: string; clientSecret: string; credentials: T | null } | null {
    const row = this.db.prepare("SELECT client_id,client_secret_ciphertext,credentials_ciphertext FROM connectors WHERE id=?").get(id) as Row | undefined;
    if (!row?.client_id || !row.client_secret_ciphertext) return null;
    let credentials: T | null = null;
    if (row.credentials_ciphertext) {
      try { credentials = JSON.parse(this.vault.decrypt(String(row.credentials_ciphertext))) as T; } catch { credentials = null; }
    }
    const decryptedSecret = this.vault.decrypt(String(row.client_secret_ciphertext));
    return { clientId: String(row.client_id), clientSecret: decryptedSecret === PUBLIC_OAUTH_CLIENT ? "" : decryptedSecret, credentials };
  }

  completeOAuthConnector(id: "slack" | "notion" | "todoist" | "dropbox", credentials: Record<string, unknown>, accountName: string, scopes: string[]): ConnectorConnection {
    const names = { slack: "Slack", notion: "Notion", todoist: "Todoist", dropbox: "Dropbox" } as const;
    if (!this.getConnector(id)) throw new Error(`Configure ${names[id]} before connecting it.`);
    this.db.prepare("UPDATE connectors SET authorization_version=authorization_version+1,credentials_ciphertext=?,account_email=?,scopes_json=?,status='connected',last_error=NULL,last_used_at=?,updated_at=? WHERE id=?").run(
      this.vault.encrypt(JSON.stringify(credentials)), accountName.slice(0, 200), JSON.stringify([...new Set(scopes)]), now(), now(), id,
    );
    return this.getConnector(id)!;
  }

  updateOAuthConnectorCredentials(id: "slack" | "notion" | "todoist" | "dropbox", credentials: Record<string, unknown>, expectedVersion?: number): ConnectorConnection {
    if (expectedVersion !== undefined && this.connectorAuthorizationVersion(id) !== expectedVersion) throw new Error("The connected account changed during sign-in refresh. Reconnect from Apps & Tools.");
    this.db.prepare("UPDATE connectors SET credentials_ciphertext=?,status='connected',last_error=NULL,last_used_at=?,updated_at=? WHERE id=?").run(
      this.vault.encrypt(JSON.stringify(credentials)), now(), now(), id,
    );
    const connector = this.getConnector(id);
    if (!connector) throw new Error("That connector is not configured.");
    return connector;
  }

  disconnectOAuthConnector(id: "slack" | "notion" | "todoist" | "dropbox"): ConnectorConnection | null {
    this.db.prepare("UPDATE connectors SET authorization_version=authorization_version+1,credentials_ciphertext=NULL,scopes_json='[]',account_email=NULL,status=CASE WHEN client_id IS NULL THEN 'unconfigured' ELSE 'configured' END,last_error=NULL,updated_at=? WHERE id=?").run(now(), id);
    return this.getConnector(id);
  }

  configureGoogleConnector(input: { clientId: string; clientSecret?: string | null }): ConnectorConnection {
    const id = "google-workspace", existing = this.db.prepare("SELECT * FROM connectors WHERE id=?").get(id) as Row | undefined;
    const changedClient = Boolean(existing?.client_id && String(existing.client_id) !== input.clientId);
    const encryptedSecret = input.clientSecret ? this.vault.encrypt(input.clientSecret) : changedClient ? null : existing?.client_secret_ciphertext || null;
    const at = now(), status = changedClient || !existing?.access_token_ciphertext ? "configured" : existing.status || "configured";
    this.db.prepare(`INSERT INTO connectors
      (id,owner_id,kind,name,client_id,client_secret_ciphertext,access_token_ciphertext,refresh_token_ciphertext,token_expires_at,scopes_json,account_email,status,last_error,last_used_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,NULL,NULL,NULL,'[]',NULL,?,NULL,NULL,?,?)
      ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,client_secret_ciphertext=excluded.client_secret_ciphertext,
      access_token_ciphertext=CASE WHEN ? THEN NULL ELSE connectors.access_token_ciphertext END,
      refresh_token_ciphertext=CASE WHEN ? THEN NULL ELSE connectors.refresh_token_ciphertext END,
      token_expires_at=CASE WHEN ? THEN NULL ELSE connectors.token_expires_at END,
      scopes_json=CASE WHEN ? THEN '[]' ELSE connectors.scopes_json END,
      account_email=CASE WHEN ? THEN NULL ELSE connectors.account_email END,status=?,last_error=NULL,updated_at=excluded.updated_at`).run(
      id, DEFAULT_OWNER, "google_workspace", "Google Workspace", input.clientId, encryptedSecret, status, existing?.created_at || at, at,
      changedClient ? 1 : 0, changedClient ? 1 : 0, changedClient ? 1 : 0, changedClient ? 1 : 0, changedClient ? 1 : 0, status,
    );
    if (changedClient) this.db.prepare("UPDATE connectors SET authorization_version=authorization_version+1 WHERE id=?").run(id);
    return this.getConnector(id)!;
  }

  googleConnectorCredentials(): { clientId: string; clientSecret: string | null; accessToken: string | null; refreshToken: string | null; expiresAt: string | null } | null {
    const row = this.db.prepare("SELECT * FROM connectors WHERE id='google-workspace'").get() as Row | undefined;
    if (!row?.client_id) return null;
    const decrypt = (value: string | number | null | undefined) => value ? this.vault.decrypt(String(value)) : null;
    return {
      clientId: String(row.client_id), clientSecret: decrypt(row.client_secret_ciphertext), accessToken: decrypt(row.access_token_ciphertext),
      refreshToken: decrypt(row.refresh_token_ciphertext), expiresAt: row.token_expires_at ? String(row.token_expires_at) : null,
    };
  }

  completeGoogleConnector(input: { accessToken: string; refreshToken?: string | null; expiresAt: string; scopes: string[]; accountEmail: string }): ConnectorConnection {
    const existing = this.db.prepare("SELECT refresh_token_ciphertext FROM connectors WHERE id='google-workspace'").get() as Row | undefined;
    if (!existing) throw new Error("Configure Google Workspace before connecting it.");
    const refresh = input.refreshToken ? this.vault.encrypt(input.refreshToken) : existing.refresh_token_ciphertext;
    this.db.prepare(`UPDATE connectors SET authorization_version=authorization_version+1,access_token_ciphertext=?,refresh_token_ciphertext=?,token_expires_at=?,scopes_json=?,account_email=?,status='connected',last_error=NULL,last_used_at=?,updated_at=? WHERE id='google-workspace'`).run(
      this.vault.encrypt(input.accessToken), refresh, input.expiresAt, JSON.stringify([...new Set(input.scopes)]), input.accountEmail, now(), now(),
    );
    for (const bot of this.listBots()) {
      this.setBotConnectorAccess(bot.id, { canRead: true, canSend: true }, "gmail");
      this.setBotConnectorAccess(bot.id, { canRead: true, canSend: false }, "google-drive");
      this.setBotConnectorAccess(bot.id, { canRead: true, canSend: false }, "google-calendar");
    }
    this.clearConnectorServiceError("gmail");
    return this.getConnector("google-workspace")!;
  }

  updateGoogleAccessToken(accessToken: string, expiresAt: string, refreshToken?: string | null, expectedVersion?: number) {
    if (expectedVersion !== undefined && this.connectorAuthorizationVersion("google-workspace") !== expectedVersion) throw new Error("The Google account changed during sign-in refresh. Reconnect from Apps & Tools.");
    const existing = this.db.prepare("SELECT refresh_token_ciphertext FROM connectors WHERE id='google-workspace'").get() as Row | undefined;
    if (!existing) throw new Error("Google Workspace is not configured.");
    const refresh = refreshToken ? this.vault.encrypt(refreshToken) : existing.refresh_token_ciphertext;
    this.db.prepare(`UPDATE connectors SET access_token_ciphertext=?,refresh_token_ciphertext=?,token_expires_at=?,status='connected',last_error=NULL,last_used_at=?,updated_at=? WHERE id='google-workspace'`).run(
      this.vault.encrypt(accessToken), refresh, expiresAt, now(), now(),
    );
  }

  connectorAuthorizationVersion(id: string): number {
    return Number((this.db.prepare("SELECT authorization_version FROM connectors WHERE id=?").get(id) as Row | undefined)?.authorization_version || 0);
  }

  getWorkSources(botId: string): WorkSourcesSettings {
    if (!this.getBot(botId)) throw new Error("Choose a teammate in this studio.");
    const row = this.db.prepare("SELECT revision,settings_encrypted FROM work_source_settings WHERE bot_id=?").get(botId) as Row | undefined;
    if (!row) return { lookbackHours: 24, selections: [], revision: 0, connectionVersions: {} };
    const { connectionVersions = {}, ...input } = JSON.parse(this.vault.decrypt(String(row.settings_encrypted)));
    return { ...workSourcesInput.parse(input), connectionVersions, revision: Number(row.revision) };
  }

  setWorkSources(botId: string, value: unknown): WorkSourcesSettings {
    const input = workSourcesInput.parse(value), prior = this.getWorkSources(botId);
    const connectionVersions = Object.fromEntries([...new Set(input.selections.map((entry) => entry.service))].map((service) => [service, this.connectorAuthorizationVersion(service)]));
    if (JSON.stringify(input) === JSON.stringify({ lookbackHours: prior.lookbackHours, selections: prior.selections }) && JSON.stringify(connectionVersions) === JSON.stringify(prior.connectionVersions)) return prior;
    this.db.prepare(`INSERT INTO work_source_settings (bot_id,revision,settings_encrypted) VALUES (?,1,?)
      ON CONFLICT(bot_id) DO UPDATE SET revision=revision+1,settings_encrypted=excluded.settings_encrypted`).run(botId, this.vault.encrypt(JSON.stringify({ ...input, connectionVersions })));
    return this.getWorkSources(botId);
  }

  markConnectorUsed(id: string) {
    this.db.prepare("UPDATE connectors SET last_used_at=?,updated_at=? WHERE id=?").run(now(), now(), id);
  }

  markConnectorError(id: string, error: string) {
    this.db.prepare("UPDATE connectors SET status='needs_attention',last_error=?,updated_at=? WHERE id=?").run(error.slice(0, 600), now(), id);
  }

  markConnectorHealthy(id: string) {
    this.db.prepare("UPDATE connectors SET status='connected',last_error=NULL,last_used_at=?,updated_at=? WHERE id=? AND credentials_ciphertext IS NOT NULL").run(now(), now(), id);
    return this.getConnector(id);
  }

  restoreGoogleConnectorAfterStaleCallback(): ConnectorConnection | null {
    this.db.prepare(`UPDATE connectors SET status='connected',last_error=NULL,updated_at=?
      WHERE id='google-workspace' AND status='needs_attention' AND last_error LIKE 'That Google sign-in expired.%'
      AND account_email IS NOT NULL AND (access_token_ciphertext IS NOT NULL OR refresh_token_ciphertext IS NOT NULL)`).run(now());
    return this.getConnector("google-workspace");
  }

  restoreGoogleConnectorAfterServiceError(): ConnectorConnection | null {
    this.db.prepare(`UPDATE connectors SET status='connected',last_error=NULL,updated_at=?
      WHERE id='google-workspace' AND status='needs_attention'
      AND last_error LIKE '%API has not been used in project%before or it is disabled%'
      AND account_email IS NOT NULL AND (access_token_ciphertext IS NOT NULL OR refresh_token_ciphertext IS NOT NULL)`).run(now());
    return this.getConnector("google-workspace");
  }

  markConnectorServiceError(service: GoogleConnectorService, error: string, connectorId = "google-workspace") {
    this.db.prepare(`INSERT INTO connector_service_errors (connector_id,service,last_error,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(connector_id,service) DO UPDATE SET last_error=excluded.last_error,updated_at=excluded.updated_at`).run(connectorId, service, error.slice(0, 600), now());
  }

  clearConnectorServiceError(service: GoogleConnectorService, connectorId = "google-workspace") {
    this.db.prepare("DELETE FROM connector_service_errors WHERE connector_id=? AND service=?").run(connectorId, service);
  }

  listConnectorServiceErrors(connectorId = "google-workspace"): Array<{ service: GoogleConnectorService; error: string }> {
    return (this.db.prepare("SELECT service,last_error FROM connector_service_errors WHERE connector_id=? ORDER BY updated_at DESC").all(connectorId) as Row[]).map((row) => ({ service: row.service as GoogleConnectorService, error: String(row.last_error) }));
  }

  disconnectGoogleConnector(): ConnectorConnection | null {
    this.db.prepare(`UPDATE connectors SET authorization_version=authorization_version+1,access_token_ciphertext=NULL,refresh_token_ciphertext=NULL,token_expires_at=NULL,scopes_json='[]',account_email=NULL,status=CASE WHEN client_id IS NULL THEN 'unconfigured' ELSE 'configured' END,last_error=NULL,updated_at=? WHERE id='google-workspace'`).run(now());
    this.db.prepare("DELETE FROM connector_service_errors WHERE connector_id='google-workspace'").run();
    return this.getConnector("google-workspace");
  }

  ensureLocalConnector(id: string, kind: ConnectorConnection["kind"], name: string, connected: boolean, accountLogin: string | null = null): ConnectorConnection {
    const existing = this.getConnector(id), expectedStatus = connected ? "connected" : "configured";
    if (existing && existing.kind === kind && existing.name === name && existing.status === expectedStatus && existing.accountEmail === accountLogin) return existing;
    const at = now();
    this.db.prepare(`INSERT INTO connectors
      (id,owner_id,kind,name,client_id,scopes_json,account_email,status,created_at,updated_at)
      VALUES (?,?,?,?,?,'[]',?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,account_email=excluded.account_email,status=excluded.status,updated_at=excluded.updated_at`).run(
      id, DEFAULT_OWNER, kind, name, "local-cli", accountLogin, expectedStatus, at, at,
    );
    return this.getConnector(id)!;
  }

  listBotConnectorAccess(connectorId = "google-workspace"): BotConnectorAccess[] {
    return (this.db.prepare("SELECT * FROM bot_connector_access WHERE connector_id=? ORDER BY rowid").all(connectorId) as Row[]).map((row) => ({
      botId: String(row.bot_id), connectorId: String(row.connector_id), service: row.service as ConnectorServiceId, canRead: asBoolean(row.can_read),
      canSend: asBoolean(row.can_send), updatedAt: String(row.updated_at),
    }));
  }

  getBotConnectorAccess(botId: string, service: ConnectorServiceId = "gmail", connectorId = "google-workspace"): BotConnectorAccess | null {
    return this.listBotConnectorAccess(connectorId).find((access) => access.botId === botId && access.service === service) || null;
  }

  setBotConnectorAccess(botId: string, input: { canRead: boolean; canSend: boolean }, service: ConnectorServiceId = "gmail", connectorId = "google-workspace"): BotConnectorAccess {
    if (!this.getBot(botId) || !this.getConnector(connectorId)) throw new Error("Choose a valid teammate and connector.");
    const at = now();
    this.db.prepare(`INSERT INTO bot_connector_access (bot_id,connector_id,service,can_read,can_send,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(bot_id,connector_id,service) DO UPDATE SET can_read=excluded.can_read,can_send=excluded.can_send,updated_at=excluded.updated_at`).run(
      botId, connectorId, service, input.canRead ? 1 : 0, input.canSend ? 1 : 0, at, at,
    );
    return this.getBotConnectorAccess(botId, service, connectorId)!;
  }

  addConnectorEvent(input: { connectorId?: string; botId?: string | null; action: string; status: ConnectorEvent["status"]; summary: string }): ConnectorEvent {
    const event: ConnectorEvent = {
      id: randomUUID(), connectorId: input.connectorId || "google-workspace", botId: input.botId || null,
      botName: input.botId ? this.getBot(input.botId)?.name || null : null, action: input.action, status: input.status,
      summary: input.summary.slice(0, 300), createdAt: now(),
    };
    this.db.prepare("INSERT INTO connector_events (id,connector_id,bot_id,action,status,summary,created_at) VALUES (?,?,?,?,?,?,?)").run(
      event.id, event.connectorId, event.botId, event.action, event.status, event.summary, event.createdAt,
    );
    return event;
  }

  listConnectorEvents(connectorId = "google-workspace", limit = 20): ConnectorEvent[] {
    return (this.db.prepare(`SELECT e.*,b.name bot_name FROM connector_events e LEFT JOIN bots b ON b.id=e.bot_id WHERE e.connector_id=? ORDER BY e.created_at DESC LIMIT ?`).all(connectorId, Math.max(1, Math.min(limit, 100))) as Row[]).map((row) => ({
      id: String(row.id), connectorId: String(row.connector_id), botId: row.bot_id ? String(row.bot_id) : null,
      botName: row.bot_name ? String(row.bot_name) : null, action: String(row.action), status: row.status as ConnectorEvent["status"],
      summary: String(row.summary), createdAt: String(row.created_at),
    }));
  }

  listCodeProjectAccess(projectId?: string): CodeProjectAccess[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM bot_project_access WHERE project_id=? ORDER BY rowid").all(projectId) as Row[]
      : this.db.prepare("SELECT * FROM bot_project_access ORDER BY rowid").all() as Row[];
    return rows.map((row) => ({
      botId: String(row.bot_id), projectId: String(row.project_id), canRead: asBoolean(row.can_read), canWrite: asBoolean(row.can_write),
      canRun: asBoolean(row.can_run), updatedAt: String(row.updated_at),
    }));
  }

  private codeProjectFromRow(row: Row): CodeProject {
    const id = String(row.id);
    return {
      id, ownerId: String(row.owner_id), name: String(row.name), rootPath: String(row.root_path),
      gitRepository: asBoolean(row.git_repository), projectKind: String(row.project_kind), remoteUrl: row.remote_url ? String(row.remote_url) : null,
      defaultBranch: row.default_branch ? String(row.default_branch) : null, managedClone: asBoolean(row.managed_clone), access: this.listCodeProjectAccess(id),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  listCodeProjects(botId?: string): CodeProject[] {
    const rows = botId
      ? this.db.prepare(`SELECT p.* FROM code_projects p JOIN bot_project_access a ON a.project_id=p.id WHERE p.connected=1 AND a.bot_id=? AND a.can_read=1 ORDER BY p.updated_at DESC`).all(botId) as Row[]
      : this.db.prepare("SELECT * FROM code_projects WHERE connected=1 ORDER BY updated_at DESC").all() as Row[];
    return rows.map((row) => this.codeProjectFromRow(row));
  }

  getCodeProject(id: string): CodeProject | null {
    const row = this.db.prepare("SELECT * FROM code_projects WHERE id=? AND connected=1").get(id) as Row | undefined;
    return row ? this.codeProjectFromRow(row) : null;
  }

  getCodeProjectForBot(botId: string, projectId: string, capability: "read" | "write" | "run" = "read"): CodeProject | null {
    const project = this.getCodeProject(projectId), access = project?.access.find((item) => item.botId === botId);
    if (!project || !access?.canRead) return null;
    if (capability === "write" && !access.canWrite) return null;
    if (capability === "run" && !access.canRun) return null;
    return project;
  }

  createCodeProject(input: { name: string; rootPath: string; gitRepository: boolean; projectKind: string; remoteUrl?: string | null; defaultBranch?: string | null; managedClone?: boolean; access: Array<{ botId: string; canRead: boolean; canWrite: boolean; canRun: boolean }> }): CodeProject {
    const existing = this.db.prepare("SELECT * FROM code_projects WHERE root_path=?").get(input.rootPath) as Row | undefined;
    if (existing && asBoolean(existing.connected)) throw new Error("That project folder is already connected.");
    const id = existing ? String(existing.id) : randomUUID(), at = now();
    this.db.exec("BEGIN");
    try {
      if (existing) {
        this.db.prepare("UPDATE code_projects SET name=?,git_repository=?,project_kind=?,remote_url=?,default_branch=?,managed_clone=?,connected=1,updated_at=? WHERE id=?").run(input.name, input.gitRepository ? 1 : 0, input.projectKind, input.remoteUrl || null, input.defaultBranch || null, input.managedClone ? 1 : 0, at, id);
        this.db.prepare("DELETE FROM bot_project_access WHERE project_id=?").run(id);
      } else {
        this.db.prepare("INSERT INTO code_projects (id,owner_id,name,root_path,git_repository,project_kind,remote_url,default_branch,managed_clone,connected,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)").run(
          id, DEFAULT_OWNER, input.name, input.rootPath, input.gitRepository ? 1 : 0, input.projectKind, input.remoteUrl || null, input.defaultBranch || null, input.managedClone ? 1 : 0, at, at,
        );
      }
      for (const grant of input.access) {
        if (!this.getBot(grant.botId)) continue;
        this.db.prepare("INSERT INTO bot_project_access (bot_id,project_id,can_read,can_write,can_run,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
          grant.botId, id, grant.canRead ? 1 : 0, grant.canWrite && grant.canRead ? 1 : 0, grant.canRun && grant.canRead ? 1 : 0, at, at,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getCodeProject(id)!;
  }

  setCodeProjectAccess(projectId: string, botId: string, input: { canRead: boolean; canWrite: boolean; canRun: boolean }): CodeProjectAccess {
    if (!this.getCodeProject(projectId) || !this.getBot(botId)) throw new Error("Choose a valid code project and teammate.");
    const at = now();
    this.db.prepare(`INSERT INTO bot_project_access (bot_id,project_id,can_read,can_write,can_run,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(bot_id,project_id) DO UPDATE SET can_read=excluded.can_read,can_write=excluded.can_write,can_run=excluded.can_run,updated_at=excluded.updated_at`).run(
      botId, projectId, input.canRead ? 1 : 0, input.canWrite && input.canRead ? 1 : 0, input.canRun && input.canRead ? 1 : 0, at, at,
    );
    return this.listCodeProjectAccess(projectId).find((item) => item.botId === botId)!;
  }

  deleteCodeProject(id: string): boolean {
    if (!this.getCodeProject(id)) return false;
    const at = now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE code_projects SET connected=0,updated_at=? WHERE id=?").run(at, id);
      this.db.prepare("DELETE FROM bot_project_access WHERE project_id=?").run(id);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordCodeProjectEdit(input: { projectId: string; botId: string; path: string; operation: "created" | "updated"; additions: number; deletions: number; beforeContent: string | null; afterHash: string; workspaceRunId?: string | null }): CodeProjectEdit {
    const id = randomUUID(), createdAt = now();
    this.db.prepare("INSERT INTO code_project_edits (id,project_id,bot_id,path,operation,additions,deletions,before_content,after_hash,workspace_run_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      id, input.projectId, input.botId, input.path, input.operation, input.additions, input.deletions, input.beforeContent, input.afterHash, input.workspaceRunId || null, createdAt,
    );
    const bot = this.getBot(input.botId)!;
    return { id, projectId: input.projectId, botId: input.botId, botName: bot.name, path: input.path, operation: input.operation, additions: input.additions, deletions: input.deletions, workspaceRunId: input.workspaceRunId || null, reversible: true, restoredAt: null, createdAt };
  }

  listCodeProjectEdits(projectId?: string, limit = 30): CodeProjectEdit[] {
    const rows = projectId
      ? this.db.prepare(`SELECT e.*,b.name bot_name FROM code_project_edits e JOIN bots b ON b.id=e.bot_id WHERE e.project_id=? ORDER BY e.created_at DESC LIMIT ?`).all(projectId, limit) as Row[]
      : this.db.prepare(`SELECT e.*,b.name bot_name FROM code_project_edits e JOIN bots b ON b.id=e.bot_id ORDER BY e.created_at DESC LIMIT ?`).all(limit) as Row[];
    return rows.map((row) => ({ id: String(row.id), projectId: String(row.project_id), botId: String(row.bot_id), botName: String(row.bot_name), path: String(row.path), operation: row.operation as CodeProjectEdit["operation"], additions: Number(row.additions), deletions: Number(row.deletions), workspaceRunId: row.workspace_run_id ? String(row.workspace_run_id) : null, reversible: Boolean(row.after_hash) && !row.restored_at, restoredAt: row.restored_at ? String(row.restored_at) : null, createdAt: String(row.created_at) }));
  }

  getCodeProjectEdit(id: string): ({ beforeContent: string | null; afterHash: string } & CodeProjectEdit) | null {
    const row = this.db.prepare(`SELECT e.*,b.name bot_name FROM code_project_edits e JOIN bots b ON b.id=e.bot_id WHERE e.id=?`).get(id) as Row | undefined;
    if (!row) return null;
    return { id: String(row.id), projectId: String(row.project_id), botId: String(row.bot_id), botName: String(row.bot_name), path: String(row.path), operation: row.operation as CodeProjectEdit["operation"], additions: Number(row.additions), deletions: Number(row.deletions), workspaceRunId: row.workspace_run_id ? String(row.workspace_run_id) : null, reversible: Boolean(row.after_hash) && !row.restored_at, restoredAt: row.restored_at ? String(row.restored_at) : null, createdAt: String(row.created_at), beforeContent: row.before_content === null || row.before_content === undefined ? null : String(row.before_content), afterHash: String(row.after_hash || "") };
  }

  markCodeProjectEditRestored(id: string) {
    this.db.prepare("UPDATE code_project_edits SET restored_at=? WHERE id=? AND restored_at IS NULL").run(now(), id);
  }

  createCodeTaskWorkspace(input: { runId: string; projectId: string; botId: string; branch: string; rootPath: string }): CodeTaskWorkspace {
    const at = now();
    this.db.prepare("INSERT INTO code_task_workspaces (run_id,project_id,bot_id,branch,root_path,status,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?)").run(input.runId, input.projectId, input.botId, input.branch, input.rootPath, at, at);
    return this.getCodeTaskWorkspace(input.runId)!;
  }

  private codeTaskWorkspaceFromRow(row: Row): CodeTaskWorkspace {
    return { runId: String(row.run_id), projectId: String(row.project_id), projectName: String(row.project_name), botId: String(row.bot_id), botName: String(row.bot_name), branch: String(row.branch), rootPath: String(row.root_path), status: row.status as CodeTaskWorkspace["status"], createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }

  getCodeTaskWorkspace(runId: string): CodeTaskWorkspace | null {
    const row = this.db.prepare(`SELECT w.*,p.name project_name,b.name bot_name FROM code_task_workspaces w JOIN code_projects p ON p.id=w.project_id JOIN bots b ON b.id=w.bot_id WHERE w.run_id=?`).get(runId) as Row | undefined;
    return row ? this.codeTaskWorkspaceFromRow(row) : null;
  }

  listCodeTaskWorkspaces(projectId?: string): CodeTaskWorkspace[] {
    const rows = (projectId
      ? this.db.prepare(`SELECT w.*,p.name project_name,b.name bot_name FROM code_task_workspaces w JOIN code_projects p ON p.id=w.project_id JOIN bots b ON b.id=w.bot_id WHERE w.project_id=? ORDER BY w.updated_at DESC`).all(projectId)
      : this.db.prepare(`SELECT w.*,p.name project_name,b.name bot_name FROM code_task_workspaces w JOIN code_projects p ON p.id=w.project_id JOIN bots b ON b.id=w.bot_id ORDER BY w.updated_at DESC`).all()) as Row[];
    return rows.map((row) => this.codeTaskWorkspaceFromRow(row));
  }

  updateCodeTaskWorkspaceStatus(runId: string, status: CodeTaskWorkspace["status"]) {
    this.db.prepare("UPDATE code_task_workspaces SET status=?,updated_at=? WHERE run_id=?").run(status, now(), runId);
  }

  recordCodeTaskReview(input: { sourceRunId: string; reviewerRunId: string; projectId: string; reviewerBotId: string; verdict: CodeTaskReview["verdict"]; summary: string; findings: string[]; headCommit: string }): CodeTaskReview {
    const id = randomUUID(), createdAt = now();
    this.db.prepare("INSERT INTO code_task_reviews (id,source_run_id,reviewer_run_id,project_id,reviewer_bot_id,verdict,summary,findings_json,head_commit,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      id, input.sourceRunId, input.reviewerRunId, input.projectId, input.reviewerBotId, input.verdict, input.summary, JSON.stringify(input.findings), input.headCommit, createdAt,
    );
    return this.getCodeTaskReviewByReviewerRun(input.reviewerRunId)!;
  }

  private codeTaskReviewFromRow(row: Row): CodeTaskReview {
    return {
      id: String(row.id), sourceRunId: String(row.source_run_id), reviewerRunId: String(row.reviewer_run_id), projectId: String(row.project_id),
      reviewerBotId: String(row.reviewer_bot_id), reviewerBotName: String(row.reviewer_bot_name), verdict: row.verdict as CodeTaskReview["verdict"],
      summary: String(row.summary), findings: jsonArray<string>(row.findings_json).filter((finding) => typeof finding === "string"), headCommit: String(row.head_commit), createdAt: String(row.created_at),
    };
  }

  getCodeTaskReviewByReviewerRun(runId: string): CodeTaskReview | null {
    const row = this.db.prepare(`SELECT r.*,b.name reviewer_bot_name FROM code_task_reviews r JOIN bots b ON b.id=r.reviewer_bot_id WHERE r.reviewer_run_id=?`).get(runId) as Row | undefined;
    return row ? this.codeTaskReviewFromRow(row) : null;
  }

  latestCodeTaskReview(sourceRunId: string): CodeTaskReview | null {
    const row = this.db.prepare(`SELECT r.*,b.name reviewer_bot_name FROM code_task_reviews r JOIN bots b ON b.id=r.reviewer_bot_id WHERE r.source_run_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(sourceRunId) as Row | undefined;
    return row ? this.codeTaskReviewFromRow(row) : null;
  }

  listCodeTaskReviews(projectId?: string): CodeTaskReview[] {
    const rows = (projectId
      ? this.db.prepare(`SELECT r.*,b.name reviewer_bot_name FROM code_task_reviews r JOIN bots b ON b.id=r.reviewer_bot_id WHERE r.project_id=? ORDER BY r.created_at DESC`).all(projectId)
      : this.db.prepare(`SELECT r.*,b.name reviewer_bot_name FROM code_task_reviews r JOIN bots b ON b.id=r.reviewer_bot_id ORDER BY r.created_at DESC`).all()) as Row[];
    return rows.map((row) => this.codeTaskReviewFromRow(row));
  }

  remember(botId: string, key: string, content: string, options: { source?: "owner" | "task"; runId?: string; expectedRevision?: string; requireRevision?: boolean; expiresAt?: string | null } = {}) {
    if (!this.getBot(botId)) throw new Error("This teammate no longer exists.");
    key = key.trim(); content = content.trim();
    if (!key || key.length > 80 || !content || content.length > 1_200 || /[\u0000\u202a-\u202e\u2066-\u2069]/u.test(key + content)) throw new Error("Save a short memory: a name under 80 characters and a note under 1,200 characters.");
    if (/-----BEGIN .*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/.test(content)) throw new Error("Keep credentials in connection settings, not in memory.");
    const source = options.source || "owner";
    if (source === "task") {
      const run = options.runId ? this.getRun(options.runId) : null;
      if (!run || run.botId !== botId || run.status !== "running") throw new Error("Save a task memory only from this teammate's active task.");
    }
    const matches = this.memoryEntries(botId, true).filter((note) => memoryKeyIdentity(note.key) === memoryKeyIdentity(key));
    const existing = matches.find((note) => note.key === key) || (matches.length === 1 ? matches[0] : undefined);
    if (matches.length > 1 && (source === "task" || !existing)) throw new Error("These saved notes conflict. Ask the owner to review them; do not save the same preference under another name.");
    if (source === "task" && !existing) {
      const rival = nearDuplicateNote(content, this.memoryEntries(botId, true).filter((note) => note.source === "owner" && memoryKeyIdentity(note.key) !== memoryKeyIdentity(key)));
      if (rival) throw new Error(`A similar owner note "${rival.key}" already exists. Ask the owner to consolidate into it instead of saving a competing preference.`);
    }
    if (existing && source === "task" && existing.source !== "task") {
      if (existing.content === content && !existing.expired) return { saved: true, unchanged: true };
      throw new Error("This preference is protected by the owner or predates source tracking. Ask the owner to correct it; do not override it or save a competing copy.");
    }
    if (existing && (options.requireRevision || options.expectedRevision || source === "task") && options.expectedRevision !== existing.revision) throw new Error("This note changed or needs a fresh review. Reload the saved note before correcting it.");
    if (!existing && options.expectedRevision) throw new Error("This note was removed. Review before saving a new note.");
    let expiresAt = options.expiresAt === undefined ? (source === "task" ? new Date(Date.now() + 30 * 86400_000).toISOString() : existing?.expiresAt || null) : options.expiresAt;
    if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) throw new Error("Choose a valid expiry date.");
    if (source === "task" && (expiresAt === null || Date.parse(expiresAt) > Date.now() + 366 * 86400_000)) throw new Error("Task notes need an expiry within a year. Only the owner can keep a note indefinitely.");
    if (expiresAt) expiresAt = new Date(expiresAt).toISOString();
    const count = Number((this.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE bot_id=? AND memory_key<>?").get(botId, existing?.key || key) as Row).count);
    if (count >= 100) throw new Error("This teammate has 100 memories. Correct or remove an existing note before adding another.");
    this.db.prepare(`INSERT INTO memories (id,bot_id,memory_key,content,updated_at,revision,source,source_run_id,expires_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(bot_id,memory_key) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at,revision=excluded.revision,source=excluded.source,source_run_id=excluded.source_run_id,expires_at=excluded.expires_at`).run(randomUUID(), botId, existing?.key || key, content, now(), randomUUID(), source, source === "task" ? options.runId! : null, expiresAt);
    this.deleteMemoryVectors(botId, existing?.key || key);
    this.saveExtensionRecord("memory-revision", botId, randomUUID());
    return { saved: true, unchanged: false };
  }

  forgetMemory(botId: string, key: string, expectedRevision?: string, requireRevision = false) {
    const existing = this.memoryEntries(botId, true).find((note) => note.key === key);
    if (existing && (requireRevision || expectedRevision) && existing.revision !== expectedRevision) throw new Error("This note changed. Reload it before forgetting it.");
    this.db.prepare("DELETE FROM memories WHERE bot_id=? AND memory_key=?").run(botId, key);
    this.deleteMemoryVectors(botId, key);
    this.saveExtensionRecord("memory-revision", botId, randomUUID());
  }

  memoryEntries(botId: string, includeExpired = false, at = Date.now()): PrivateMemory[] {
    const rows = this.db.prepare("SELECT memory_key,content,updated_at,revision,source,source_run_id,expires_at FROM memories WHERE bot_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 100").all(botId) as Row[];
    const activeKeys = rows.filter((row) => !row.expires_at || Date.parse(String(row.expires_at)) > at).map((row) => memoryKeyIdentity(String(row.memory_key)));
    return rows.map((row) => ({ key: String(row.memory_key), content: String(row.content), updatedAt: String(row.updated_at), revision: String(row.revision), source: row.source as PrivateMemory["source"], sourceRunId: row.source_run_id ? String(row.source_run_id) : null, expiresAt: row.expires_at ? String(row.expires_at) : null, expired: Boolean(row.expires_at && Date.parse(String(row.expires_at)) <= at), conflict: activeKeys.filter((key) => key === memoryKeyIdentity(String(row.memory_key))).length > 1 })).filter((note) => includeExpired || !note.expired);
  }

  searchMemories(botId: string, query: string) {
    return rankMemories(query, this.memoryEntries(botId), 18);
  }

  /** Cached meaning-vectors for one embeddings model. The embedded text is
   * stored alongside so edited notes are re-embedded instead of trusted. */
  getMemoryVectors(botId: string, model: string): Map<string, { text: string; vector: number[] }> {
    const rows = this.db.prepare("SELECT memory_key,text,vector FROM memory_embeddings WHERE bot_id=? AND model=?").all(botId, model) as Row[];
    const vectors = new Map<string, { text: string; vector: number[] }>();
    for (const row of rows) {
      try {
        const vector = JSON.parse(String(row.vector)) as unknown;
        if (Array.isArray(vector) && vector.length && vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
          vectors.set(String(row.memory_key), { text: String(row.text), vector });
        }
      } catch { /* A corrupt cache row is re-embedded on next search. */ }
    }
    return vectors;
  }

  saveMemoryVectors(botId: string, model: string, entries: Array<{ key: string; text: string; vector: number[] }>) {
    const at = now();
    const save = this.db.prepare("INSERT INTO memory_embeddings (bot_id,memory_key,model,dims,text,vector,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(bot_id,memory_key) DO UPDATE SET model=excluded.model,dims=excluded.dims,text=excluded.text,vector=excluded.vector,updated_at=excluded.updated_at");
    for (const entry of entries) save.run(botId, entry.key, model, entry.vector.length, entry.text, JSON.stringify(entry.vector), at);
  }

  deleteMemoryVectors(botId: string, key?: string) {
    if (key) this.db.prepare("DELETE FROM memory_embeddings WHERE bot_id=? AND memory_key=?").run(botId, key);
    else this.db.prepare("DELETE FROM memory_embeddings WHERE bot_id=?").run(botId);
  }

  listAutoReviewRules(): AutoReviewRule[] {
    return (this.db.prepare("SELECT id,effect,scope,pattern,created_at FROM auto_review_rules ORDER BY created_at DESC,length(pattern) DESC").all() as Row[]).map((row) => ({
      id: String(row.id), effect: String(row.effect) as AutoReviewRule["effect"], scope: String(row.scope) as AutoReviewRule["scope"], pattern: String(row.pattern), createdAt: String(row.created_at),
    }));
  }

  saveAutoReviewRule(input: { id?: string; effect: AutoReviewRule["effect"]; scope: AutoReviewRule["scope"]; pattern: string }): AutoReviewRule {
    const pattern = input.pattern.trim().replace(/\s+/g, " ");
    if (!pattern || pattern.length > 160) throw new Error("Write a matching pattern between 1 and 160 characters.");
    if (input.scope === "command" && input.effect === "always_allow" && !input.id) {
      const bare = pattern.replace(/\*+$/g, "").trimEnd();
      if (["rm", "rmdir", "shred", "find", "sudo", "chmod", "chown"].includes(bare.toLowerCase())) throw new Error("Never allow deleting or system-changing commands; write a narrower pattern such as \"git status*\".");
    }
    const existing = input.id ? this.listAutoReviewRules().find((rule) => rule.id === input.id) : undefined;
    const id = existing?.id || randomUUID();
    const createdAt = existing?.createdAt || now();
    this.db.prepare("INSERT INTO auto_review_rules (id,effect,scope,pattern,created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET effect=excluded.effect,scope=excluded.scope,pattern=excluded.pattern").run(id, input.effect, input.scope, pattern, createdAt);
    return { id, effect: input.effect, scope: input.scope, pattern, createdAt };
  }

  deleteAutoReviewRule(id: string): boolean {
    const result = this.db.prepare("DELETE FROM auto_review_rules WHERE id=?").run(id);
    return Number(result.changes) > 0;
  }

  /** Recent conversation text related to a new request, keyword-ranked.
   * Bounded to this bot's own answers plus owner messages in the task's thread. */
  relatedHistory(botId: string, threadId: string, query: string): Array<{ body: string; score: number }> {
    const rows = this.db.prepare(
      "SELECT body FROM messages WHERE ((sender_type='bot' AND sender_id=?) OR (thread_id=? AND sender_type='user')) AND length(body)>=60 ORDER BY created_at DESC LIMIT 400",
    ).all(botId, threadId) as Row[];
    return rankTexts(query, rows.map((row) => ({ body: String(row.body), text: String(row.body) })), 3)
      .map(({ item, score }) => ({ body: item.body, score }));
  }

  listMemories(botId: string): Array<{ key: string; content: string }> {
    return this.memoryEntries(botId).filter((note) => !note.conflict).slice(0, 30).map((note) => ({ key: note.key, content: note.content }));
  }

  claimDedupe(key: string): boolean {
    try { this.db.prepare("INSERT INTO dedupe_keys (dedupe_key,created_at) VALUES (?,?)").run(key, now()); return true; } catch { return false; }
  }

  releaseDedupe(key: string): void {
    this.db.prepare("DELETE FROM dedupe_keys WHERE dedupe_key=?").run(key);
  }

  /** Durable POST /api/messages submission receipt (P01). First writer wins;
   * a retried requestId with the same digest replays stored IDs instead of
   * creating a second message/routine/run. Same requestId with a different
   * digest is a caller conflict — the stored row is never overwritten here. */
  getMessageSubmission(requestId: string): MessageSubmissionReceipt | null {
    const row = this.db.prepare("SELECT * FROM message_submissions WHERE request_id=?").get(requestId) as Row | undefined;
    if (!row) return null;
    return {
      requestId: String(row.request_id),
      threadId: String(row.thread_id),
      payloadDigest: String(row.payload_digest),
      messageId: row.message_id ? String(row.message_id) : null,
      runIds: jsonArray<string>(row.run_ids_json),
      routineIds: jsonArray<string>(row.routine_ids_json),
      routedTo: jsonArray<{ id: string; name: string }>(row.routed_to_json),
      attachmentIds: jsonArray<string>(row.attachment_ids_json),
      responseStatus: Number(row.response_status ?? 202),
      createdAt: String(row.created_at),
    };
  }

  saveMessageSubmission(input: {
    requestId: string; threadId: string; payloadDigest: string;
    messageId: string | null; runIds: string[]; routineIds: string[];
    routedTo: Array<{ id: string; name: string }>; attachmentIds: string[];
    responseStatus: number;
  }): MessageSubmissionReceipt {
    const createdAt = now();
    try {
      this.db.prepare(`INSERT INTO message_submissions
        (request_id,thread_id,payload_digest,message_id,run_ids_json,routine_ids_json,routed_to_json,attachment_ids_json,response_status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        input.requestId, input.threadId, input.payloadDigest, input.messageId,
        JSON.stringify(input.runIds), JSON.stringify(input.routineIds),
        JSON.stringify(input.routedTo), JSON.stringify(input.attachmentIds),
        input.responseStatus, createdAt,
      );
    } catch {
      // A concurrent identical submission already stored its receipt: keep the
      // original so a retry can never fork a second message/run history.
      const existing = this.getMessageSubmission(input.requestId);
      if (existing) return existing;
      throw new Error("That request is already being processed. Reuse its result instead of sending it again.");
    }
    this.pruneMessageSubmissions(1000);
    return this.getMessageSubmission(input.requestId)!;
  }

  /** Bounded retention: keep the most recent receipts so transport retries
   * inside the retry window replay instead of duplicating. Oldest rows fall
   * off; an intentionally repeated task must use a new requestId.
   * R01 fail-closed: tombstone retention and receipt deletion commit
   * atomically. If any replacement tombstone cannot be persisted, the whole
   * prune aborts and the original receipts are retained — a failed
   * compaction never discards the durable record it was meant to replace. */
  pruneMessageSubmissions(limit = 1000): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM message_submissions").get() as Row;
    const over = Number(row?.count ?? 0) - Math.max(1, limit);
    if (over <= 0) return 0;
    const evicted = this.db.prepare(`SELECT request_id,thread_id,payload_digest,created_at FROM message_submissions ORDER BY created_at ASC,rowid ASC LIMIT ?`).all(over) as Row[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const evictedRow of evicted) {
        this.saveExtensionRecord("message-submission-tombstone", String(evictedRow.request_id), {
          requestId: String(evictedRow.request_id),
          threadId: String(evictedRow.thread_id),
          payloadDigest: String(evictedRow.payload_digest),
          createdAt: String(evictedRow.created_at),
          reason: "pruned",
        });
      }
      this.db.prepare(`DELETE FROM message_submissions WHERE request_id IN (
        SELECT request_id FROM message_submissions ORDER BY created_at ASC,rowid ASC LIMIT ?
      )`).run(over);
      this.db.exec("COMMIT");
    } catch {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      return 0;
    }
    return over;
  }

  /** R01: startup repair for pending submission intents with no receipt.
   * Converts orphans to tombstones (uncertain, never auto-retried) and
   * returns the count repaired. Fail-closed: a pending marker is cleared
   * only after its replacement tombstone is durably stored. If the
   * tombstone write fails, the marker is kept for the next startup — an
   * unresolved earlier outcome stays unresolved and recoverable instead of
   * being silently forgotten. */
  repairPendingSubmissionIntents(): number {
    let repaired = 0;
    for (const { id, value } of this.extensionRecords<{ requestId: string; threadId: string; payloadDigest: string }>("message-submission-pending")) {
      if (this.getMessageSubmission(id)) {
        this.deleteExtensionRecord("message-submission-pending", id);
        continue;
      }
      try {
        this.saveExtensionRecord("message-submission-tombstone", id, {
          requestId: String(value.requestId ?? id),
          threadId: String(value.threadId ?? ""),
          payloadDigest: String(value.payloadDigest ?? ""),
          createdAt: now(),
          reason: "orphan-repaired",
        });
      } catch {
        continue;
      }
      this.deleteExtensionRecord("message-submission-pending", id);
      repaired += 1;
    }
    return repaired;
  }

  /** Scoped external-object identity (P04a). One row per connector resource
   * created through an approved action: which account and authorization
   * version created it, which thread/run/bot owns it, the exact reviewed
   * fields, and the last read-back state. Corrections (P04b) resolve the
   * same resource id in the same account — never by title alone — and a
   * changed account or authorization version invalidates the reference. */
  getConnectorTaskRef(connectorId: string, resourceId: string): ConnectorTaskRef | null {
    const row = this.db.prepare("SELECT * FROM connector_task_refs WHERE connector_id=? AND resource_id=?").get(connectorId, resourceId) as Row | undefined;
    if (!row) return null;
    return {
      connectorId: String(row.connector_id),
      resourceId: String(row.resource_id),
      account: String(row.account || ""),
      authorizationVersion: Number(row.authorization_version || 0),
      threadId: String(row.thread_id),
      runId: String(row.run_id),
      botId: String(row.bot_id),
      reviewedFields: JSON.parse(String(row.reviewed_fields_json || "{}")) as ConnectorTaskRef["reviewedFields"],
      lastState: JSON.parse(String(row.last_state_json || "{}")) as TodoistTaskSummary,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  saveConnectorTaskRef(input: {
    connectorId: string; resourceId: string; account: string; authorizationVersion: number;
    threadId: string; runId: string; botId: string;
    reviewedFields: ConnectorTaskRef["reviewedFields"]; lastState: TodoistTaskSummary;
  }): ConnectorTaskRef {
    const at = now();
    this.db.prepare(`INSERT INTO connector_task_refs
      (connector_id,resource_id,account,authorization_version,thread_id,run_id,bot_id,reviewed_fields_json,last_state_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(connector_id,resource_id) DO UPDATE SET
        account=excluded.account,authorization_version=excluded.authorization_version,
        thread_id=excluded.thread_id,run_id=excluded.run_id,bot_id=excluded.bot_id,
        reviewed_fields_json=excluded.reviewed_fields_json,last_state_json=excluded.last_state_json,
        updated_at=excluded.updated_at`).run(
      input.connectorId, input.resourceId, input.account, input.authorizationVersion,
      input.threadId, input.runId, input.botId,
      JSON.stringify(input.reviewedFields), JSON.stringify(input.lastState), at, at,
    );
    return this.getConnectorTaskRef(input.connectorId, input.resourceId)!;
  }

  runDepth(runId: string): number {
    const row = this.db.prepare(`WITH RECURSIVE chain(id,parent_run_id,depth) AS (
      SELECT id,parent_run_id,0 FROM runs WHERE id=?
      UNION ALL SELECT r.id,r.parent_run_id,chain.depth+1 FROM runs r JOIN chain ON r.id=chain.parent_run_id WHERE chain.depth<20
    ) SELECT MAX(depth) depth FROM chain`).get(runId) as Row | undefined;
    return Number(row?.depth || 0);
  }

  rootRunId(runId: string): string {
    const row = this.db.prepare(`WITH RECURSIVE chain(id,parent_run_id,depth) AS (
      SELECT id,parent_run_id,0 FROM runs WHERE id=?
      UNION ALL SELECT r.id,r.parent_run_id,chain.depth+1 FROM runs r JOIN chain ON r.id=chain.parent_run_id WHERE chain.depth<20
    ) SELECT id FROM chain ORDER BY depth DESC LIMIT 1`).get(runId) as Row | undefined;
    return row?.id ? String(row.id) : runId;
  }

  descendantRunCount(runId: string): number {
    const root = this.rootRunId(runId);
    const row = this.db.prepare(`WITH RECURSIVE tree(id) AS (
      SELECT id FROM runs WHERE id=?
      UNION ALL SELECT r.id FROM runs r JOIN tree ON r.parent_run_id=tree.id
    ) SELECT COUNT(*) count FROM tree`).get(root) as Row | undefined;
    return Number(row?.count || 0);
  }

  addAgentMessage(input: {
    threadId: string; fromBotId: string; toBotId: string; body: string; kind: AgentMessageKind; expectsReply: boolean;
    runId: string; replyToId?: string | null; hopCount: number; dedupeKey: string;
  }): AgentMessage | null {
    const id = randomUUID();
    try {
      this.db.prepare(`INSERT INTO agent_messages (id,thread_id,from_bot_id,to_bot_id,body,kind,expects_reply,run_id,reply_to_id,hop_count,dedupe_key,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.threadId, input.fromBotId, input.toBotId, input.body, input.kind, input.expectsReply ? 1 : 0, input.runId, input.replyToId || null, input.hopCount, input.dedupeKey, now());
    } catch { return null; }
    return this.getAgentMessage(id);
  }

  private agentMessageSelect(where: string) {
    return `SELECT am.*,fb.name from_name,fb.mascot from_mascot,fb.color from_color,tb.name to_name,tb.mascot to_mascot,tb.color to_color
      FROM agent_messages am JOIN bots fb ON fb.id=am.from_bot_id JOIN bots tb ON tb.id=am.to_bot_id ${where}`;
  }

  private agentMessageFromRow(row: Row): AgentMessage {
    return {
      id: String(row.id), threadId: String(row.thread_id), fromBotId: String(row.from_bot_id), fromBotName: String(row.from_name),
      fromBotMascot: String(row.from_mascot) as MascotKind, fromBotColor: String(row.from_color), toBotId: String(row.to_bot_id),
      toBotName: String(row.to_name), toBotMascot: String(row.to_mascot) as MascotKind, toBotColor: String(row.to_color),
      body: String(row.body), kind: row.kind as AgentMessageKind, expectsReply: asBoolean(row.expects_reply), runId: String(row.run_id),
      replyToId: row.reply_to_id ? String(row.reply_to_id) : null, hopCount: Number(row.hop_count || 0), createdAt: String(row.created_at),
    };
  }

  getAgentMessage(id: string): AgentMessage | null {
    const row = this.db.prepare(this.agentMessageSelect("WHERE am.id=?")).get(id) as Row | undefined;
    return row ? this.agentMessageFromRow(row) : null;
  }

  hasAgentMessageDedupeKey(key: string): boolean {
    const row = this.db.prepare("SELECT EXISTS(SELECT 1 FROM agent_messages WHERE dedupe_key=?) present").get(key) as Row | undefined;
    return asBoolean(row?.present);
  }

  listAgentMessages(threadId?: string, limit = 40): AgentMessage[] {
    const rows = threadId
      ? this.db.prepare(`SELECT * FROM (${this.agentMessageSelect("WHERE am.thread_id=? ORDER BY am.created_at DESC LIMIT ?")}) ORDER BY created_at ASC`).all(threadId, limit) as Row[]
      : this.db.prepare(`SELECT * FROM (${this.agentMessageSelect("ORDER BY am.created_at DESC LIMIT ?")}) ORDER BY created_at ASC`).all(limit) as Row[];
    return rows.map((row) => this.agentMessageFromRow(row));
  }

  listAgentInbox(botId: string, threadId: string, limit = 8): AgentMessage[] {
    const rows = this.db.prepare(`${this.agentMessageSelect("WHERE am.to_bot_id=? AND am.thread_id=? ORDER BY am.created_at DESC LIMIT ?")}`).all(botId, threadId, limit) as Row[];
    return rows.reverse().map((row) => this.agentMessageFromRow(row));
  }

  hasAgentMessage(runId: string, fromBotId: string, toBotId: string): boolean {
    const row = this.db.prepare("SELECT EXISTS(SELECT 1 FROM agent_messages WHERE run_id=? AND from_bot_id=? AND to_bot_id=?) present").get(runId, fromBotId, toBotId) as Row | undefined;
    return asBoolean(row?.present);
  }

  createRoutine(input: { name: string; botId: string; threadId: string; prompt: string; intervalMinutes: number; schedule?: RoutineSchedule; enabled?: boolean; triggerType?: AutomationTriggerType; triggerConfig?: RoutineTriggerConfig; webhookSecret?: string | null }): Routine {
    if (input.enabled !== false) new WorkflowValidation(this).assertRoutine(input);
    const id = randomUUID();
    new WorkflowValidation(this).routineBinding({ ...input, id });
    const intervalMinutes = normalizeRoutineInterval(input.intervalMinutes);
    const triggerType = input.triggerType || "schedule";
    if (triggerType === "webpage" && input.intervalMinutes < 15) throw new Error("Page watches check at most once every 15 minutes.");
    if (triggerType === "webpage" && this.listRoutines().filter((routine) => routine.triggerType === "webpage").length >= 20) throw new Error("This studio supports up to 20 page watches.");
    const triggerConfig = normalizedTriggerConfig(triggerType, input.triggerConfig);
    const enabled = input.enabled !== false;
    const schedule = triggerType === "schedule" ? routineScheduleInput.parse(input.schedule ?? intervalSchedule) : intervalSchedule;
    const nextRunAt = enabled && triggerType === "schedule" ? nextRoutineOccurrence(schedule, intervalMinutes, Date.now()) : null;
    if (enabled && triggerType === "schedule" && schedule.kind === "once" && !nextRunAt) throw new Error("Choose a future date for this one-time routine.");
    const lastEventAt = ["todoist", "dropbox", "slack", "notion"].includes(triggerType) ? now() : null;
    this.db.prepare("INSERT INTO routines (id,name,bot_id,thread_id,prompt,cadence,interval_minutes,schedule_json,trigger_type,trigger_config_json,webhook_secret_ciphertext,enabled,next_run_at,last_event_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, input.name, input.botId, input.threadId, input.prompt, legacyCadence(intervalMinutes), intervalMinutes, JSON.stringify(schedule), triggerType, JSON.stringify(triggerConfig), input.webhookSecret ? this.vault.encrypt(input.webhookSecret) : null, enabled ? 1 : 0, nextRunAt, lastEventAt);
    new WorkflowValidation(this).bindRoutine({ ...input, id });
    return this.getRoutine(id)!;
  }

  /** Idempotency is deliberately scoped to one model run and one exact,
   * normalized payload. The receipt outlives deletion so a transport retry can
   * never recreate something the owner intentionally removed. */
  createRoutineForRun(runId: string, input: Parameters<OpenBotDatabase["createRoutine"]>[0]): { routine: Routine | null; replayed: boolean; deleted: boolean } {
    const digest = createHash("sha256").update(stableJson(input)).digest("hex");
    const receiptId = `${runId}:${digest}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.getRun(runId);
      if (!run || run.botId !== input.botId || run.threadId !== input.threadId) throw new Error("The routine does not belong to this task.");
      const existing = this.extensionRecord<{ routineId: string }>("routine-create", receiptId);
      if (existing) {
        const routine = this.getRoutine(existing.routineId);
        this.db.exec("COMMIT");
        return { routine, replayed: true, deleted: !routine };
      }
      const routine = this.createRoutine(input);
      this.saveExtensionRecord("routine-create", receiptId, { routineId: routine.id });
      this.db.exec("COMMIT");
      return { routine, replayed: false, deleted: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private routineFromRow(row: Row): Routine {
    const schedule = row.schedule_json ? routineScheduleInput.parse(JSON.parse(String(row.schedule_json))) : intervalSchedule;
    let watchStatus: Routine["watchStatus"];
    if (row.trigger_type === "webpage") {
      try { const saved = JSON.parse(this.automationCursor(String(row.id), "webpage") || "null");
        if (saved) { const { state, checkedAt, nextCheckAt, checks, unchangedChecks, detail } = saved; watchStatus = { state, checkedAt, nextCheckAt, checks, unchangedChecks, detail }; }
      } catch { /* Invalid checkpoint is reported by the monitor, not as success. */ }
    }
    return {
      schedule, scheduleLabel: scheduleLabel(schedule, Number(row.interval_minutes || (row.cadence === "hourly" ? 60 : 1440))),
      ...(watchStatus ? { watchStatus } : {}),
      id: String(row.id), name: String(row.name), botId: String(row.bot_id), botName: String(row.bot_name), botEmoji: String(row.bot_emoji),
      threadId: String(row.thread_id), prompt: String(row.prompt), cadence: row.cadence as Routine["cadence"], intervalMinutes: normalizeRoutineInterval(Number(row.interval_minutes || (row.cadence === "hourly" ? 60 : 1440))), enabled: asBoolean(row.enabled),
      triggerType: String(row.trigger_type || "schedule") as AutomationTriggerType, triggerConfig: jsonRecord(row.trigger_config_json) as RoutineTriggerConfig,
      hasWebhookSecret: Boolean(row.webhook_secret_ciphertext),
      nextRunAt: row.next_run_at ? String(row.next_run_at) : null, lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
      lastStatus: (row.last_status || "never") as Routine["lastStatus"], runCount: Number(row.run_count || 0),
      consecutiveFailures: Number(row.consecutive_failures || 0), deduplicatedCount: Number(row.deduplicated_count || 0),
      lastError: row.last_error ? String(row.last_error) : null, pausedReason: row.paused_reason ? String(row.paused_reason) : null,
      revision: Number(row.revision || 1),
      lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null, lastEventAt: row.last_event_at ? String(row.last_event_at) : null,
    };
  }

  getRoutine(id: string): Routine | null {
    const row = this.db.prepare("SELECT r.*,b.name bot_name,b.emoji bot_emoji FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=?").get(id) as Row | undefined;
    return row ? this.routineFromRow(row) : null;
  }

  /** All routines, or only the routines of one conversation when threadId is
   * given. Scoped listing (P03a) is the identity foundation for follow-up
   * management: corrections resolve these ids, never titles alone. */
  listRoutines(threadId?: string): Routine[] {
    if (!threadId) return (this.db.prepare("SELECT r.*,b.name bot_name,b.emoji bot_emoji FROM routines r JOIN bots b ON b.id=r.bot_id ORDER BY r.rowid DESC").all() as Row[]).map((row) => this.routineFromRow(row));
    return (this.db.prepare("SELECT r.*,b.name bot_name,b.emoji bot_emoji FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.thread_id=? ORDER BY r.rowid DESC").all(threadId) as Row[]).map((row) => this.routineFromRow(row));
  }

  updateRoutine(id: string, input: { name: string; botId: string; threadId: string; prompt: string; intervalMinutes: number; schedule?: RoutineSchedule; enabled: boolean; triggerType?: AutomationTriggerType; triggerConfig?: RoutineTriggerConfig; webhookSecret?: string | null }, expectedRevision?: number): Routine | null {
    const routine = this.getRoutine(id);
    if (!routine) return null;
    // P03b: stale writers lose instead of silently overwriting a newer
    // schedule. Absent expectedRevision keeps legacy owner-UI behavior.
    if (expectedRevision !== undefined && routine.revision !== expectedRevision) {
      throw new RoutineRevisionConflictError(routine.revision);
    }
    new WorkflowValidation(this).routineBinding({ ...input, id });
    if (input.enabled) new WorkflowValidation(this).assertRoutine({ ...input, id });
    const intervalMinutes = normalizeRoutineInterval(input.intervalMinutes);
    const triggerType = input.triggerType || routine.triggerType;
    if (triggerType === "webpage" && input.intervalMinutes < 15) throw new Error("Page watches check at most once every 15 minutes.");
    if (triggerType === "webpage" && routine.triggerType !== "webpage" && this.listRoutines().filter((entry) => entry.triggerType === "webpage").length >= 20) throw new Error("This studio supports up to 20 page watches.");
    const triggerConfig = normalizedTriggerConfig(triggerType, input.triggerConfig ?? routine.triggerConfig);
    if (routine.triggerType === "webpage" && (triggerType !== "webpage" || routine.botId !== input.botId || routine.threadId !== input.threadId || JSON.stringify(routine.triggerConfig) !== JSON.stringify(triggerConfig))) this.db.prepare("DELETE FROM automation_cursors WHERE routine_id=? AND source='webpage'").run(id);
    const schedule = triggerType === "schedule" ? routineScheduleInput.parse(input.schedule ?? routine.schedule ?? intervalSchedule) : intervalSchedule;
    const scheduleChanged = (schedule.kind === "interval" && routine.intervalMinutes !== intervalMinutes) || JSON.stringify(schedule) !== JSON.stringify(routine.schedule) || routine.enabled !== input.enabled || routine.triggerType !== triggerType;
    const nextRunAt = input.enabled && triggerType === "schedule" ? (scheduleChanged || !routine.nextRunAt ? nextRoutineOccurrence(schedule, intervalMinutes, Date.now()) : routine.nextRunAt) : null;
    if (input.enabled && triggerType === "schedule" && schedule.kind === "once" && !nextRunAt) throw new Error("Choose a future date for this one-time routine.");
    const secret = input.webhookSecret ? this.vault.encrypt(input.webhookSecret) : undefined;
    const connectorTriggerChanged = ["todoist", "dropbox"].includes(triggerType) && routine.triggerType !== triggerType;
    const lastEventAt = connectorTriggerChanged ? now() : routine.lastEventAt;
    if (connectorTriggerChanged) this.db.prepare("DELETE FROM automation_cursors WHERE routine_id=?").run(id);
    else if (triggerType === "dropbox" && routine.triggerConfig.dropboxPath !== triggerConfig.dropboxPath) this.db.prepare("DELETE FROM automation_cursors WHERE routine_id=? AND source='dropbox'").run(id);
    this.db.prepare("UPDATE routines SET name=?,bot_id=?,thread_id=?,prompt=?,cadence=?,interval_minutes=?,schedule_json=?,trigger_type=?,trigger_config_json=?,webhook_secret_ciphertext=COALESCE(?,webhook_secret_ciphertext),enabled=?,next_run_at=?,last_event_at=?,paused_reason=CASE WHEN ? THEN NULL ELSE paused_reason END,revision=revision+1 WHERE id=?").run(
      input.name, input.botId, input.threadId, input.prompt, legacyCadence(intervalMinutes), intervalMinutes, JSON.stringify(schedule), triggerType, JSON.stringify(triggerConfig), secret ?? null, input.enabled ? 1 : 0, nextRunAt, lastEventAt, input.enabled ? 1 : 0, id,
    );
    // P03c: resuming restarts connector automations from a fresh baseline no
    // matter which writer enabled it (owner UI toggle, PATCH, or reviewed
    // model resume). Pause preserves cursors; only the paused→running
    // transition rebaselines, exactly like the legacy toggle did.
    if (input.enabled && !routine.enabled) {
      if (["todoist", "dropbox"].includes(triggerType)) this.db.prepare("DELETE FROM automation_cursors WHERE routine_id=?").run(id);
      if (["todoist", "dropbox", "slack", "notion"].includes(triggerType)) this.db.prepare("UPDATE routines SET last_event_at=? WHERE id=?").run(now(), id);
    }
    new WorkflowValidation(this).bindRoutine({ ...input, id });
    return this.getRoutine(id);
  }

  deleteRoutine(id: string, deletedByRunId: string | null = null): boolean {
    const routine = this.getRoutine(id);
    if (!routine) return false;
    if (this.db.prepare("DELETE FROM routines WHERE id=?").run(id).changes === 0) return false;
    // First receipt wins: a routine id is never reused, so the original
    // deletion record stays the attributable one.
    this.db.prepare(`INSERT OR IGNORE INTO deleted_routine_receipts
      (routine_id,name,bot_id,thread_id,trigger_type,revision_at_delete,deleted_by_run_id,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      id, routine.name, routine.botId, routine.threadId, routine.triggerType,
      routine.revision, deletedByRunId, now(),
    );
    return true;
  }

  getDeletedRoutineReceipt(id: string): DeletedRoutineReceipt | null {
    const row = this.db.prepare("SELECT * FROM deleted_routine_receipts WHERE routine_id=?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      routineId: String(row.routine_id), name: String(row.name), botId: String(row.bot_id),
      threadId: String(row.thread_id), triggerType: String(row.trigger_type || "schedule"),
      revisionAtDelete: Number(row.revision_at_delete || 1),
      deletedByRunId: row.deleted_by_run_id ? String(row.deleted_by_run_id) : null,
      createdAt: String(row.created_at),
    };
  }

  toggleRoutine(id: string, enabled: boolean, expectedRevision?: number): Routine | null {
    // P03c: the legacy toggle shares the guarded update path instead of
    // bypassing revision safety with its own UPDATE.
    const routine = this.getRoutine(id);
    if (!routine) return null;
    if (enabled === routine.enabled) return routine;
    return this.updateRoutine(id, {
      name: routine.name, botId: routine.botId, threadId: routine.threadId, prompt: routine.prompt,
      intervalMinutes: routine.intervalMinutes, schedule: routine.schedule, enabled,
      triggerType: routine.triggerType, triggerConfig: routine.triggerConfig,
    }, expectedRevision);
  }

  listRoutineRuns(id: string, limit = 20): Run[] {
    const rows = this.db.prepare(this.runSelect("WHERE r.routine_id=? ORDER BY r.created_at DESC LIMIT ?")).all(id, Math.max(1, Math.min(limit, 100))) as Row[];
    return rows.map((row) => this.runFromRow(row));
  }

  /** True while any task is queued, running or waiting on a teammate. */
  hasActiveWork(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM runs WHERE status IN ('queued','running','waiting_for_teammate') LIMIT 1").get());
  }

  /** The earliest upcoming run time of an enabled clock routine, if any. */
  nextScheduledRoutineAt(): string | null {
    const row = this.db.prepare("SELECT MIN(next_run_at) AS next FROM routines WHERE enabled=1 AND trigger_type='schedule' AND next_run_at IS NOT NULL").get() as { next: string | null } | undefined;
    return row?.next || null;
  }

  dueRoutines(): Routine[] {
    return (this.db.prepare("SELECT r.*,b.name bot_name,b.emoji bot_emoji FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.enabled=1 AND r.trigger_type='schedule' AND r.next_run_at IS NOT NULL AND r.next_run_at<=?").all(now()) as Row[]).map((row) => this.routineFromRow(row));
  }

  markRoutineRan(routine: Routine) {
    this.markRoutineDispatched(routine, true);
  }

  markRoutineDispatched(routine: Routine, advanceSchedule: boolean) {
    const ranAt = now();
    const advance = advanceSchedule && routine.enabled && routine.triggerType === "schedule";
    const advanceAfter = Math.max(Date.now(), Date.parse(routine.nextRunAt || "") || 0);
    const nextRunAt = advance ? nextRoutineOccurrence(routine.schedule ?? intervalSchedule, routine.intervalMinutes, advanceAfter) : routine.nextRunAt;
    this.db.prepare("UPDATE routines SET last_run_at=?,last_event_at=?,next_run_at=?,enabled=CASE WHEN ? THEN 0 ELSE enabled END WHERE id=?").run(ranAt, ranAt, nextRunAt, advance && routine.schedule?.kind === "once" ? 1 : 0, routine.id);
  }

  // Receipt, job, linked messages and occurrence advancement are one durable
  // commit. Recheck after acquiring the write lock: another host may have won.
  dispatchScheduledOccurrence(id: string, expectedAt: string, dispatch: (routine: Routine) => void): boolean {
    return this.automationTransaction(() => {
      const routine = this.getRoutine(id);
      if (!routine?.enabled || routine.triggerType !== "schedule" || routine.nextRunAt !== expectedAt || Date.parse(expectedAt) > Date.now()) return false;
      dispatch(routine);
      this.markRoutineDispatched(routine, true);
      const delayedMs = Date.now() - Date.parse(expectedAt);
      if (delayedMs > 120_000) this.createAutomationAlert({ routineId: id, kind: "missed", message: `${routine.name} was queued ${Math.round(delayedMs / 60_000)} minutes late. Sidemates caught up once and will return to the saved schedule.` });
      return true;
    });
  }

  listCalendarRoutines(): Routine[] {
    return this.listRoutines().filter((routine) => routine.enabled && routine.triggerType === "calendar");
  }

  listConnectorRoutines(source: "todoist" | "dropbox" | "slack" | "notion"): Routine[] {
    return this.listRoutines().filter((routine) => routine.enabled && routine.triggerType === source);
  }

  automationCursor(routineId: string, source: "todoist" | "dropbox" | "webpage"): string | null {
    const row = this.db.prepare("SELECT cursor FROM automation_cursors WHERE routine_id=? AND source=?").get(routineId, source) as Row | undefined;
    return row?.cursor ? String(row.cursor) : null;
  }

  saveAutomationCursor(routineId: string, source: "todoist" | "dropbox" | "webpage", cursor: string) {
    if (cursor.length > 32_000) throw new Error("The automation checkpoint is too large.");
    this.db.prepare(`INSERT INTO automation_cursors (routine_id,source,cursor,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(routine_id,source) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at`).run(routineId, source, cursor.slice(0, 32_000), now());
  }

  // Checkpoint and dispatch commit together, including the run and its receipt.
  // Synchronous only: never hold a database transaction across a network request.
  automationTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  routineWebhookSecret(id: string): string | null {
    const row = this.db.prepare("SELECT webhook_secret_ciphertext FROM routines WHERE id=?").get(id) as Row | undefined;
    return row?.webhook_secret_ciphertext ? this.vault.decrypt(String(row.webhook_secret_ciphertext)) : null;
  }

  receiveAutomationEvent(input: { routine: Routine; source: AutomationEvent["source"]; externalId: string; dedupeKey: string; payloadSummary: string; payload: unknown; replayOfEventId?: string | null; attempt?: number; dedupeWindowMs?: number; rateLimit?: number; bypassDedupe?: boolean }): { event: AutomationEvent; duplicate: boolean; rateLimited: boolean } {
    const cutoff = new Date(Date.now() - (input.dedupeWindowMs ?? 7 * 86_400_000)).toISOString();
    if (!input.bypassDedupe) {
      const existing = this.db.prepare("SELECT * FROM automation_events WHERE routine_id=? AND dedupe_key=? AND received_at>=? AND status!='rate_limited' ORDER BY received_at DESC LIMIT 1").get(input.routine.id, input.dedupeKey, cutoff) as Row | undefined;
      if (existing) {
        this.db.prepare("UPDATE routines SET deduplicated_count=deduplicated_count+1 WHERE id=?").run(input.routine.id);
        return { event: this.automationEventFromRow(existing), duplicate: true, rateLimited: false };
      }
    }
    const rateCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    const recent = this.db.prepare("SELECT COUNT(*) count FROM automation_events WHERE routine_id=? AND received_at>=? AND status!='rate_limited'").get(input.routine.id, rateCutoff) as Row;
    const rateLimited = Number(recent.count || 0) >= (input.rateLimit ?? 10);
    const id = randomUUID(), receivedAt = now(), status: AutomationEventStatus = rateLimited ? "rate_limited" : "queued";
    const serializedPayload = JSON.stringify(input.payload) || "{}";
    const payloadJson = serializedPayload.length <= 20_000 ? serializedPayload : JSON.stringify({ truncated: true, preview: serializedPayload.slice(0, 19_000) });
    this.db.prepare("INSERT INTO automation_events (id,routine_id,routine_name,bot_id,bot_name,source,external_id,dedupe_key,status,replay_of_event_id,payload_summary,payload_json,received_at,attempt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      id, input.routine.id, input.routine.name, input.routine.botId, input.routine.botName, input.source, input.externalId, input.dedupeKey, status,
      input.replayOfEventId || null, input.payloadSummary.slice(0, 500), payloadJson, receivedAt, input.attempt || 1,
    );
    this.db.prepare("UPDATE routines SET last_event_at=? WHERE id=?").run(receivedAt, input.routine.id);
    if (rateLimited) this.createAutomationAlert({ routineId: input.routine.id, eventId: id, kind: "rate_limit", message: `${input.routine.name} received too many events and paused this one safely.` });
    return { event: this.getAutomationEvent(id)!, duplicate: false, rateLimited };
  }

  private automationEventFromRow(row: Row): AutomationEvent {
    const error = row.error ? String(row.error) : null;
    return {
      id: String(row.id), routineId: String(row.routine_id), routineName: String(row.routine_name), botId: String(row.bot_id), botName: String(row.bot_name),
      source: String(row.source) as AutomationEvent["source"], externalId: String(row.external_id), status: String(row.status) as AutomationEventStatus,
      runId: row.run_id ? String(row.run_id) : null, replayOfEventId: row.replay_of_event_id ? String(row.replay_of_event_id) : null,
      payloadSummary: String(row.payload_summary), receivedAt: String(row.received_at), finishedAt: row.finished_at ? String(row.finished_at) : null,
      error, attempt: Number(row.attempt || 1), repairHint: automationRepairHint(error),
    };
  }

  getAutomationEvent(id: string): AutomationEvent | null {
    const row = this.db.prepare("SELECT * FROM automation_events WHERE id=?").get(id) as Row | undefined;
    return row ? this.automationEventFromRow(row) : null;
  }

  automationEventPayload(id: string): unknown {
    const row = this.db.prepare("SELECT payload_json FROM automation_events WHERE id=?").get(id) as Row | undefined;
    if (!row?.payload_json) return {};
    try { return JSON.parse(String(row.payload_json)); } catch { return {}; }
  }

  listAutomationEvents(routineId?: string, limit = 80): AutomationEvent[] {
    const rows = routineId
      ? this.db.prepare("SELECT * FROM automation_events WHERE routine_id=? ORDER BY received_at DESC LIMIT ?").all(routineId, Math.max(1, Math.min(limit, 200))) as Row[]
      : this.db.prepare("SELECT * FROM automation_events ORDER BY received_at DESC LIMIT ?").all(Math.max(1, Math.min(limit, 200))) as Row[];
    return rows.map((row) => this.automationEventFromRow(row));
  }

  linkAutomationEvent(eventId: string, runId: string, status: "queued" | "waiting" = "queued") {
    this.db.prepare("UPDATE automation_events SET run_id=?,status=? WHERE id=?").run(runId, status, eventId);
  }

  createAutomationAlert(input: { routineId: string; runId?: string | null; eventId?: string | null; kind: AutomationAlert["kind"]; message: string }): AutomationAlert {
    const routine = this.getRoutine(input.routineId);
    const existing = this.db.prepare("SELECT * FROM automation_alerts WHERE routine_id=? AND kind=? AND COALESCE(run_id,'')=COALESCE(?,'') AND COALESCE(event_id,'')=COALESCE(?,'') AND resolved_at IS NULL LIMIT 1").get(input.routineId, input.kind, input.runId || null, input.eventId || null) as Row | undefined;
    if (existing) return this.automationAlertFromRow(existing);
    const id = randomUUID();
    this.db.prepare("INSERT INTO automation_alerts (id,routine_id,routine_name,run_id,event_id,kind,message,created_at) VALUES (?,?,?,?,?,?,?,?)").run(
      id, input.routineId, routine?.name || "Deleted automation", input.runId || null, input.eventId || null, input.kind, input.message.slice(0, 1_000), now(),
    );
    if (!input.runId || input.kind === "missed" || input.kind === "rate_limit") this.enqueueNotification({
      dedupeKey: `automation-alert:${id}`, kind: `automation_${input.kind}`, title: routine?.name || "Sidemates automation",
      body: input.message, url: "/?panel=routines",
    });
    return this.listAutomationAlerts().find((alert) => alert.id === id)!;
  }

  private automationAlertFromRow(row: Row): AutomationAlert {
    const event = row.event_id ? this.getAutomationEvent(String(row.event_id)) : null;
    const error = event?.error || String(row.message || "");
    return {
      id: String(row.id), routineId: String(row.routine_id), routineName: String(row.routine_name), runId: row.run_id ? String(row.run_id) : null,
      eventId: row.event_id ? String(row.event_id) : null, kind: String(row.kind) as AutomationAlert["kind"], message: String(row.message),
      repairHint: row.kind === "missed" && !event?.error && String(row.message).includes("caught up once")
        ? null : automationRepairHint(error), createdAt: String(row.created_at), resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    };
  }

  listAutomationAlerts(includeResolved = false): AutomationAlert[] {
    const rows = this.db.prepare(`SELECT * FROM automation_alerts ${includeResolved ? "" : "WHERE resolved_at IS NULL"} ORDER BY created_at DESC LIMIT 100`).all() as Row[];
    return rows.map((row) => this.automationAlertFromRow(row));
  }

  resolveAutomationAlert(id: string): boolean {
    return this.db.prepare("UPDATE automation_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL").run(now(), id).changes > 0;
  }

  nextWorkflowSlug(botId: string, name: string, excludedId?: string): string {
    const base = skillSlug(name), used = new Set(this.listWorkflows().filter((workflow) => workflow.id !== excludedId).map((workflow) => workflow.skillSlug));
    if (!used.has(base)) return base;
    const bot = this.getBot(botId), botSuffix = skillSlug(bot?.name || botId);
    if (!used.has(`${base}-${botSuffix}`)) return `${base}-${botSuffix}`;
    let suffix = 2;
    while (used.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  }

  saveWorkflow(input: { botId: string; name: string; description?: string; instructions?: string; startUrl: string; steps: unknown[]; skillPath: string; skillSlug: string; source?: TaughtWorkflow["source"] }): TaughtWorkflow {
    const id = randomUUID(), createdAt = now();
    const description = input.description?.trim() || `Repeat the saved ${input.name} workflow.`;
    const instructions = input.instructions?.trim() || `Start at ${input.startUrl}, follow the demonstrated steps, and verify the result.`;
    this.db.prepare("INSERT INTO taught_workflows (id,bot_id,name,description,instructions,start_url,steps_json,skill_path,skill_slug,version,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)").run(
      id, input.botId, input.name, description, instructions, input.startUrl, JSON.stringify(input.steps), input.skillPath, input.skillSlug, input.source || "taught", createdAt, createdAt,
    );
    this.db.prepare("INSERT INTO workflow_versions (id,workflow_id,version,name,description,instructions,start_url,steps_json,created_at) VALUES (?,?,1,?,?,?,?,?,?)").run(
      randomUUID(), id, input.name, description, instructions, input.startUrl, JSON.stringify(input.steps), createdAt,
    );
    return this.listWorkflows(input.botId).find((workflow) => workflow.id === id)!;
  }

  private workflowFromRow(row: Row): TaughtWorkflow {
    return {
      id: String(row.id), botId: String(row.bot_id), botName: String(row.bot_name), name: String(row.name),
      skillSlug: row.skill_slug ? String(row.skill_slug) : skillSlug(String(row.name)),
      description: String(row.description || `Repeat the saved ${row.name} workflow.`),
      instructions: String(row.instructions || `Start at ${row.start_url}, follow the demonstrated steps, and verify the result.`),
      startUrl: String(row.start_url), stepCount: jsonArray<unknown>(row.steps_json).length, version: Number(row.version || 1),
      disabled: asBoolean(row.disabled),
      source: (["taught", "imported", "template", "assigned", "proposed"].includes(String(row.source)) ? String(row.source) : "taught") as TaughtWorkflow["source"],
      createdAt: String(row.created_at), updatedAt: String(row.updated_at || row.created_at),
    };
  }

  /** Per-skill enablement: a disabled skill stays in the library but is not
   * routable and its skill files are removed from the teammate's harness
   * directories, so the model cannot load it at all. */
  setWorkflowEnabled(id: string, enabled: boolean): TaughtWorkflow | null {
    const workflow = this.getWorkflowRecord(id)?.workflow;
    if (!workflow) return null;
    this.db.prepare("UPDATE taught_workflows SET disabled=?, updated_at=? WHERE id=?").run(enabled ? 0 : 1, now(), id);
    return this.listWorkflows(workflow.botId).find((entry) => entry.id === id) || null;
  }

  listWorkflows(botId?: string): TaughtWorkflow[] {
    const rows = botId
      ? this.db.prepare("SELECT w.*,b.name bot_name FROM taught_workflows w JOIN bots b ON b.id=w.bot_id WHERE w.bot_id=? ORDER BY w.updated_at DESC,w.created_at DESC").all(botId) as Row[]
      : this.db.prepare("SELECT w.*,b.name bot_name FROM taught_workflows w JOIN bots b ON b.id=w.bot_id ORDER BY w.updated_at DESC,w.created_at DESC").all() as Row[];
    return rows.map((row) => this.workflowFromRow(row));
  }

  getWorkflowRecord(id: string): { workflow: TaughtWorkflow; steps: unknown[]; skillPath: string } | null {
    const row = this.db.prepare("SELECT w.*,b.name bot_name FROM taught_workflows w JOIN bots b ON b.id=w.bot_id WHERE w.id=?").get(id) as Row | undefined;
    if (!row) return null;
    return { workflow: this.workflowFromRow(row), steps: jsonArray<unknown>(row.steps_json), skillPath: String(row.skill_path) };
  }

  reviseWorkflowRecord(id: string, input: { name: string; description: string; instructions: string; startUrl: string; steps: unknown[]; skillSlug: string; skillPath: string }): TaughtWorkflow | null {
    const current = this.getWorkflowRecord(id);
    if (!current) return null;
    // Preserve stable references before a rename changes the slash command.
    for (const routine of this.listRoutines()) new WorkflowValidation(this).bindRoutine(routine);
    if (current.workflow.skillSlug !== input.skillSlug) this.saveExtensionRecord("retired-workflow-slug", current.workflow.skillSlug, id);
    const version = current.workflow.version + 1, updatedAt = now();
    this.db.prepare("UPDATE taught_workflows SET name=?,description=?,instructions=?,start_url=?,steps_json=?,skill_slug=?,skill_path=?,version=?,updated_at=? WHERE id=?").run(
      input.name, input.description, input.instructions, input.startUrl, JSON.stringify(input.steps), input.skillSlug, input.skillPath, version, updatedAt, id,
    );
    this.db.prepare("INSERT INTO workflow_versions (id,workflow_id,version,name,description,instructions,start_url,steps_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
      randomUUID(), id, version, input.name, input.description, input.instructions, input.startUrl, JSON.stringify(input.steps), updatedAt,
    );
    return this.getWorkflowRecord(id)?.workflow || null;
  }

  updateWorkflowRecord(id: string, input: { name: string; description?: string; instructions?: string; startUrl: string; skillSlug: string; skillPath: string }): TaughtWorkflow | null {
    const current = this.getWorkflowRecord(id);
    if (!current) return null;
    return this.reviseWorkflowRecord(id, {
      ...input, description: input.description?.trim() || current.workflow.description,
      instructions: input.instructions?.trim() || current.workflow.instructions, steps: current.steps,
    });
  }

  listWorkflowVersions(workflowId: string): SkillVersion[] {
    const rows = this.db.prepare("SELECT * FROM workflow_versions WHERE workflow_id=? ORDER BY version DESC").all(workflowId) as Row[];
    return rows.map((row) => ({
      id: String(row.id), workflowId: String(row.workflow_id), version: Number(row.version), name: String(row.name),
      description: String(row.description), instructions: String(row.instructions), startUrl: String(row.start_url),
      stepCount: jsonArray<unknown>(row.steps_json).length, createdAt: String(row.created_at),
    }));
  }

  getWorkflowVersion(workflowId: string, version: number): (SkillVersion & { steps: unknown[] }) | null {
    const row = this.db.prepare("SELECT * FROM workflow_versions WHERE workflow_id=? AND version=?").get(workflowId, version) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id), workflowId: String(row.workflow_id), version: Number(row.version), name: String(row.name),
      description: String(row.description), instructions: String(row.instructions), startUrl: String(row.start_url),
      stepCount: jsonArray<unknown>(row.steps_json).length, steps: jsonArray<unknown>(row.steps_json), createdAt: String(row.created_at),
    };
  }

  deleteWorkflowRecord(id: string): { skillPath: string; botId: string } | null {
    const row = this.db.prepare("SELECT skill_path,bot_id FROM taught_workflows WHERE id=?").get(id) as Row | undefined;
    if (!row) return null;
    for (const routine of this.listRoutines()) new WorkflowValidation(this).bindRoutine(routine);
    this.saveExtensionRecord("retired-workflow-slug", this.getWorkflowRecord(id)!.workflow.skillSlug, id);
    this.db.prepare("DELETE FROM taught_workflows WHERE id=?").run(id);
    return { skillPath: String(row.skill_path), botId: String(row.bot_id) };
  }

  savePushSubscription(input: { endpoint: string; p256dh: string; auth: string }): string {
    const existing = this.db.prepare("SELECT id FROM push_subscriptions WHERE endpoint=?").get(input.endpoint) as Row | undefined;
    const id = existing?.id ? String(existing.id) : randomUUID();
    this.db.prepare(`INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,created_at,failure_count)
      VALUES (?,?,?,?,?,0) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,failure_count=0`).run(
      id, input.endpoint, input.p256dh, input.auth, now(),
    );
    return id;
  }

  listPushSubscriptions(): Array<{ id: string; endpoint: string; p256dh: string; auth: string; failureCount: number }> {
    return (this.db.prepare("SELECT * FROM push_subscriptions ORDER BY created_at DESC").all() as Row[]).map((row) => ({
      id: String(row.id), endpoint: String(row.endpoint), p256dh: String(row.p256dh), auth: String(row.auth), failureCount: Number(row.failure_count || 0),
    }));
  }

  deletePushSubscription(endpoint: string): boolean {
    return this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(endpoint).changes > 0;
  }

  recordPushSuccess(id: string) {
    this.db.prepare("UPDATE push_subscriptions SET last_success_at=?,failure_count=0 WHERE id=?").run(now(), id);
  }

  recordPushFailure(id: string) {
    this.db.prepare("UPDATE push_subscriptions SET failure_count=failure_count+1 WHERE id=?").run(id);
  }

  saveNativePushDevice(input: { deviceToken: string; environment: "sandbox" | "production"; bundleId: string }): string {
    const existing = this.db.prepare("SELECT id FROM native_push_devices WHERE device_token=?").get(input.deviceToken) as Row | undefined;
    const id = existing?.id ? String(existing.id) : randomUUID();
    this.db.prepare(`INSERT INTO native_push_devices (id,device_token,environment,bundle_id,created_at,failure_count)
      VALUES (?,?,?,?,?,0) ON CONFLICT(device_token) DO UPDATE SET environment=excluded.environment,bundle_id=excluded.bundle_id,failure_count=0`).run(
      id, input.deviceToken, input.environment, input.bundleId.slice(0, 200), now(),
    );
    return id;
  }

  listNativePushDevices(): Array<{ id: string; deviceToken: string; environment: "sandbox" | "production"; bundleId: string; failureCount: number }> {
    return (this.db.prepare("SELECT * FROM native_push_devices ORDER BY created_at DESC").all() as Row[]).map((row) => ({
      id: String(row.id), deviceToken: String(row.device_token), environment: String(row.environment) as "sandbox" | "production",
      bundleId: String(row.bundle_id), failureCount: Number(row.failure_count || 0),
    }));
  }

  deleteNativePushDevice(deviceToken: string): boolean {
    return this.db.prepare("DELETE FROM native_push_devices WHERE device_token=?").run(deviceToken).changes > 0;
  }

  recordNativePushSuccess(id: string) {
    this.db.prepare("UPDATE native_push_devices SET last_success_at=?,failure_count=0 WHERE id=?").run(now(), id);
  }

  recordNativePushFailure(id: string) {
    this.db.prepare("UPDATE native_push_devices SET failure_count=failure_count+1 WHERE id=?").run(id);
  }

  enqueueNotification(input: { dedupeKey: string; kind: string; title: string; body: string; url: string }) {
    this.db.prepare("INSERT OR IGNORE INTO notification_outbox (id,dedupe_key,kind,title,body,url,created_at) VALUES (?,?,?,?,?,?,?)").run(
      randomUUID(), input.dedupeKey, input.kind.slice(0, 80), input.title.slice(0, 160), input.body.replace(/\s+/g, " ").trim().slice(0, 500), input.url.slice(0, 500), now(),
    );
  }

  pendingNotifications(limit = 20): Array<{ id: string; kind: string; title: string; body: string; url: string; attemptCount: number }> {
    return (this.db.prepare("SELECT * FROM notification_outbox WHERE sent_at IS NULL AND attempt_count<5 ORDER BY created_at ASC LIMIT ?").all(Math.max(1, Math.min(limit, 50))) as Row[]).map((row) => ({
      id: String(row.id), kind: String(row.kind), title: String(row.title), body: String(row.body), url: String(row.url), attemptCount: Number(row.attempt_count || 0),
    }));
  }

  markNotificationSent(id: string) {
    this.db.prepare("UPDATE notification_outbox SET sent_at=?,attempt_count=attempt_count+1,last_error=NULL WHERE id=?").run(now(), id);
  }

  markNotificationFailed(id: string, error: string) {
    this.db.prepare("UPDATE notification_outbox SET attempt_count=attempt_count+1,last_error=? WHERE id=?").run(error.slice(0, 500), id);
  }

  ensureNotificationDeliveries(notificationId: string, targets: Array<{ channel: "web" | "apns"; targetId: string }>) {
    const statement = this.db.prepare("INSERT OR IGNORE INTO notification_deliveries (notification_id,channel,target_id,status,attempt_count,updated_at) VALUES (?,?,?,'pending',0,?)");
    const at = now();
    for (const target of targets) statement.run(notificationId, target.channel, target.targetId, at);
  }

  pendingNotificationDeliveries(notificationId: string): Array<{ channel: "web" | "apns"; targetId: string; attemptCount: number }> {
    return (this.db.prepare("SELECT channel,target_id,attempt_count FROM notification_deliveries WHERE notification_id=? AND status='pending' AND attempt_count<5 ORDER BY channel,target_id").all(notificationId) as Row[]).map((row) => ({
      channel: String(row.channel) as "web" | "apns", targetId: String(row.target_id), attemptCount: Number(row.attempt_count || 0),
    }));
  }

  markNotificationDeliverySent(notificationId: string, channel: "web" | "apns", targetId: string) {
    this.db.prepare("UPDATE notification_deliveries SET status='sent',attempt_count=attempt_count+1,last_error=NULL,updated_at=? WHERE notification_id=? AND channel=? AND target_id=?").run(now(), notificationId, channel, targetId);
  }

  markNotificationDeliveryFailed(notificationId: string, channel: "web" | "apns", targetId: string, error: string, permanent = false) {
    this.db.prepare(`UPDATE notification_deliveries SET status=CASE WHEN ? OR attempt_count+1>=5 THEN 'failed' ELSE 'pending' END,
      attempt_count=attempt_count+1,last_error=?,updated_at=? WHERE notification_id=? AND channel=? AND target_id=?`).run(
      permanent ? 1 : 0, error.slice(0, 500), now(), notificationId, channel, targetId,
    );
  }

  notificationDeliveriesComplete(notificationId: string): boolean {
    const row = this.db.prepare("SELECT COUNT(*) count FROM notification_deliveries WHERE notification_id=? AND status='pending' AND attempt_count<5").get(notificationId) as Row;
    return Number(row.count || 0) === 0;
  }

  getUsageSummary(): UsageSummary {
    const row = this.db.prepare(`SELECT COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,COALESCE(SUM(reasoning_tokens),0) reasoning_tokens,COALESCE(SUM(cache_read_tokens),0) cache_read_tokens,COALESCE(SUM(cache_write_tokens),0) cache_write_tokens,COALESCE(SUM(${WEEKLY_TOKENS_SQL}),0) weekly_tokens,COALESCE(SUM(cost),0) cost,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed_runs,SUM(CASE WHEN status IN ('queued','running','awaiting_approval','waiting_for_teammate') THEN 1 ELSE 0 END) active_runs FROM runs WHERE created_at>=datetime('now','-7 days')`).get() as Row;
    const inputTokens = Number(row.input_tokens || 0), outputTokens = Number(row.output_tokens || 0), reasoningTokens = Number(row.reasoning_tokens || 0), cacheReadTokens = Number(row.cache_read_tokens || 0), cacheWriteTokens = Number(row.cache_write_tokens || 0);
    return { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens: Number(row.weekly_tokens || 0), cost: Number(row.cost || 0), completedRuns: Number(row.completed_runs || 0), activeRuns: Number(row.active_runs || 0) };
  }

  budgetAvailable(botId: string, reserveTokens = 0): { allowed: boolean; used: number; budget: number; remaining: number } {
    const bot = this.getBot(botId);
    if (!bot) return { allowed: false, used: 0, budget: 0, remaining: 0 };
    const remaining = bot.weeklyTokenBudget - bot.tokensUsedThisWeek;
    // S3-P03: dispatch gates pass a step reserve so new model work only
    // starts when roughly one bounded step still fits. The default keeps
    // the historical strict used<budget gate (a one-token floor).
    const headroom = Math.max(1, reserveTokens);
    return { allowed: bot.weeklyTokenBudget <= 0 || bot.tokensUsedThisWeek + headroom <= bot.weeklyTokenBudget, used: bot.tokensUsedThisWeek, budget: bot.weeklyTokenBudget, remaining };
  }

  acquireRunnerLease(instanceId: string, mode: RunnerHealth["mode"], leaseMs = 30_000): boolean {
    const at = now(), expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db.prepare(`UPDATE runner_state SET
      instance_id=?,mode=?,started_at=CASE WHEN instance_id=? THEN COALESCE(started_at,?) ELSE ? END,
      heartbeat_at=?,lease_expires_at=?,last_cycle_at=?,last_error=NULL
      WHERE id='primary' AND (instance_id=? OR lease_expires_at IS NULL OR lease_expires_at<=?)`).run(
      instanceId, mode, instanceId, at, at, at, expiresAt, at, instanceId, at,
    );
    return result.changes > 0;
  }

  heartbeatRunner(instanceId: string, leaseMs = 30_000): boolean {
    const at = now();
    return this.db.prepare("UPDATE runner_state SET heartbeat_at=?,lease_expires_at=?,last_cycle_at=? WHERE id='primary' AND instance_id=?").run(
      at, new Date(Date.now() + leaseMs).toISOString(), at, instanceId,
    ).changes > 0;
  }

  recordRunnerDispatch(instanceId: string) {
    this.db.prepare("UPDATE runner_state SET dispatched_runs=dispatched_runs+1,last_cycle_at=? WHERE id='primary' AND instance_id=?").run(now(), instanceId);
  }

  recordRunnerRecovery(instanceId: string, count: number) {
    if (count <= 0) return;
    this.db.prepare("UPDATE runner_state SET recovered_runs=recovered_runs+?,last_cycle_at=? WHERE id='primary' AND instance_id=?").run(count, now(), instanceId);
  }

  recordRunnerError(instanceId: string, error: string) {
    this.db.prepare("UPDATE runner_state SET last_error=?,last_cycle_at=? WHERE id='primary' AND instance_id=?").run(error.slice(0, 1_000), now(), instanceId);
  }

  releaseRunnerLease(instanceId: string) {
    this.db.prepare("UPDATE runner_state SET instance_id=NULL,heartbeat_at=?,lease_expires_at=?,last_cycle_at=? WHERE id='primary' AND instance_id=?").run(now(), now(), now(), instanceId);
  }

  getRunnerHealth(): RunnerHealth {
    const row = this.db.prepare("SELECT * FROM runner_state WHERE id='primary'").get() as Row | undefined;
    const counts = this.db.prepare(`SELECT
      SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
      SUM(CASE WHEN status IN ('awaiting_approval','waiting_for_teammate') THEN 1 ELSE 0 END) waiting
      FROM runs`).get() as Row;
    const next = this.db.prepare("SELECT MIN(next_run_at) next_at FROM routines WHERE enabled=1 AND trigger_type='schedule' AND next_run_at IS NOT NULL").get() as Row;
    const expires = row?.lease_expires_at ? String(row.lease_expires_at) : null;
    const online = Boolean(row?.instance_id && expires && new Date(expires).getTime() > Date.now());
    return {
      status: online ? "online" : "offline", mode: (row?.mode === "background" ? "background" : "foreground"),
      instanceId: online && row?.instance_id ? String(row.instance_id) : null,
      startedAt: row?.started_at ? String(row.started_at) : null, heartbeatAt: row?.heartbeat_at ? String(row.heartbeat_at) : null,
      leaseExpiresAt: expires, lastCycleAt: row?.last_cycle_at ? String(row.last_cycle_at) : null,
      recoveredRuns: Number(row?.recovered_runs || 0), dispatchedRuns: Number(row?.dispatched_runs || 0),
      queuedRuns: Number(counts.queued || 0), runningRuns: Number(counts.running || 0), waitingRuns: Number(counts.waiting || 0),
      nextRoutineAt: next.next_at ? String(next.next_at) : null, lastError: row?.last_error ? String(row.last_error) : null,
      backgroundService: process.platform === "darwin" ? "not_installed" : "unsupported",
      backgroundServiceDetail: process.platform === "darwin" ? "Sidemates is running in this app session." : "Background launch is currently available on macOS.",
    };
  }

  getState(threadId?: string): AppState {
    const threads = this.listThreads();
    const activeThreadId = defaultConversation(threads, threadId);
    return { bots: this.listBots(), threads, messages: this.listMessages(activeThreadId), runs: this.listRuns(activeThreadId), studioRuns: this.listStudioRuns(), routines: this.listRoutines(), automationEvents: this.listAutomationEvents(), automationAlerts: this.listAutomationAlerts(), runner: this.getRunnerHealth(), workflows: this.listWorkflows(), approvals: this.listApprovals(), approvedActions: this.listApprovedActions(),   agentMessages: this.listAgentMessages(activeThreadId), delegations: this.listDelegations(), retiredBots: this.listBots(true).filter((bot) => bot.retiredAt), providers: this.listProviders(), settings: this.getStudioSettings(), draft: this.getDraft(activeThreadId), usage: this.getUsageSummary(), activeThreadId };
  }
}

/** After this many declined actions in one task, the next decline stops it. */
export const MAX_DECLINES_BEFORE_STOP = 3;

export function declinedActionPrompt(actionLabel: string, originalRequest: string) {
  return `The owner declined this proposed action: ${actionLabel}. Do not retry it, do not attempt an equivalent action another way (another tool, website, app, account or teammate), and do not ask for it again. Finish the task as far as you safely can without it: give the user the useful result you already have, say plainly what was not done because of the decline, and mention a simple step the owner could take themselves if one exists.\n\nOriginal request: ${originalRequest}`;
}
