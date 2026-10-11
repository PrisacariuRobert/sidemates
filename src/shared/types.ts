import type { RoutineSchedule } from "./calendar-schedule.js";

export type BotStatus = "ready" | "working" | "waiting" | "offline" | "failed" | "celebrating";
export type MascotKind = "nova" | "blob" | "sprout" | "orbit" | "pebble" | "sunny";
export type RunStatus =
  | "awaiting_approval"
  | "waiting_for_teammate"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStage = "queued" | "planning" | "working" | "checking" | "waiting" | "done" | "blocked";
export type TaskStepStatus = "pending" | "active" | "completed" | "blocked" | "skipped";
export type TaskVerificationStatus = "pending" | "passed" | "partial" | "blocked";

export interface TaskStep {
  id: number;
  title: string;
  status: TaskStepStatus;
  detail: string | null;
}

export interface TaskVerificationCheck {
  label: string;
  passed: boolean;
  source?: "teammate" | "host";
  detail?: string | null;
  /** P06a: what the host actually evaluated, e.g. "utf8-text:readable,min-bytes,markers". Teammate reports carry none. */
  predicate?: string | null;
  /** P06a: SHA-256 hex of the exact bytes the host read, so a later reader
   * can tell same-named different bytes apart. Null when nothing was read. */
  inputDigest?: string | null;
  /** P06a: SHA-256 hex of the checked output. For read checks it equals the
   * input digest; transforms record their own result digest. */
  outputDigest?: string | null;
  /** P06a: ISO time of the host observation. A receipt is evidence as of
   * this time, not a standing guarantee about later bytes. */
  observedAt?: string | null;
}

export interface TaskContract {
  tracked: boolean;
  goal: string;
  deliverable: string;
  approvalBoundary: string | null;
  requiredApps: string[];
  stage: TaskStage;
  steps: TaskStep[];
  verificationStatus: TaskVerificationStatus;
  verificationSummary: string | null;
  verificationChecks: TaskVerificationCheck[];
}

export interface Bot {
  id: string;
  ownerId: string;
  providerInstanceId: string | null;
  name: string;
  emoji: string;
  mascot: MascotKind;
  color: string;
  role: string;
  instructions: string;
  model: string;
  status: BotStatus;
  currentAction: string | null;
  computerEnabled: boolean;
  browserEnabled: boolean;
  /** Acts like a person: reviews are approved for the owner as they appear. Off unless the owner turns it on. */
  autopilot: boolean;
  /** "automatic": Sidemates picks the best connected AI before each job, and the
   * provider and model fields hold its current pick. "chosen": the owner picked them. */
  aiMode: "automatic" | "chosen";
  macAccessEnabled: boolean;
  weeklyTokenBudget: number;
  tokensUsedThisWeek: number;
  createdAt: string;
  lastActiveAt: string | null;
  threadId: string;
  retiredAt: string | null;
}

export interface Thread {
  id: string;
  title: string;
  kind: "direct" | "room";
  botId: string | null;
  botIds?: string[];
  section: string | null;
  pinned: boolean;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  unreadCount: number;
  /** The thread is waiting on the owner: an approval is open in it, or a
   * teammate escalated with @user/@owner in the current turn. */
  needsYou?: boolean;
  lastMessage?: string | null;
  lastMessageAt?: string | null;
}

export interface MessageReplyPreview {
  id: string;
  senderName: string;
  body: string;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  reactedByYou: boolean;
}

export interface Message {
  /** Provider-delimited intermediate updates, separate from the final body. */
  progressUpdates?: string[];
  id: string;
  threadId: string;
  senderType: "user" | "bot" | "system";
  senderId: string | null;
  senderName: string;
  senderEmoji: string | null;
  senderMascot: MascotKind | null;
  senderColor: string | null;
  body: string;
  createdAt: string;
  runId: string | null;
  kind: "text" | "event";
  eventType: string | null;
  eventData: Record<string, string | number | boolean | null> | null;
  replyTo: MessageReplyPreview | null;
  reactions: MessageReaction[];
  attachments: Attachment[];
}

export interface StudioSearchResult {
  id: string;
  kind: "message" | "file" | "routine" | "skill" | "teammate";
  title: string;
  subtitle: string;
  snippet: string;
  threadId: string;
  botId: string | null;
  createdAt: string;
}

export interface Attachment {
  id: string;
  threadId: string;
  messageId: string | null;
  name: string;
  mime: string;
  detectedMime: string;
  kind: "text" | "document" | "spreadsheet" | "presentation" | "image" | "audio" | "video" | "archive" | "file";
  processingStatus: "ready" | "partial" | "unsupported" | "failed";
  summary: string | null;
  previewText: string | null;
  metadata: Record<string, string | number | boolean>;
  previewUrl: string | null;
  source: "upload" | "artifact";
  revision: number;
  replacesAttachmentId: string | null;
  size: number;
  url: string;
  createdAt: string;
}

export interface SavedFile extends Pick<Attachment, "id" | "name" | "mime" | "detectedMime" | "kind" | "size" | "url" | "previewUrl" | "createdAt"> {
  sha256: string;
  savedAt: string;
}

export interface ArtifactSummary {
  id: string;
  threadId: string;
  threadTitle: string;
  botName: string | null;
  name: string;
  kind: Attachment["kind"];
  mime: string;
  size: number;
  summary: string | null;
  previewUrl: string | null;
  url: string;
  revision: number;
  revisions: number;
  createdAt: string;
}

export interface Activity {
  id: string;
  runId: string;
  botId: string;
  kind: "thought" | "tool" | "file" | "status" | "error" | "handoff" | "message";
  label: string;
  detail: string | null;
  createdAt: string;
}

export type AgentMessageKind = "message" | "question" | "finding" | "handoff";

export interface AgentMessage {
  id: string;
  threadId: string;
  fromBotId: string;
  fromBotName: string;
  fromBotMascot: MascotKind;
  fromBotColor: string;
  toBotId: string;
  toBotName: string;
  toBotMascot: MascotKind;
  toBotColor: string;
  body: string;
  kind: AgentMessageKind;
  expectsReply: boolean;
  runId: string;
  replyToId: string | null;
  hopCount: number;
  createdAt: string;
}

export interface DelegationConsultant {
  runId: string;
  botId: string;
  botName: string;
  status: RunStatus;
  detail: string | null;
}

export interface DelegationSignal {
  fromName: string;
  toName: string;
  kind: AgentMessageKind;
  body: string;
}

/** A live delegation: one teammate paused waiting on another teammate's work. */
export interface Delegation {
  runId: string;
  threadId: string;
  botId: string;
  botName: string;
  waitingSince: string;
  request: string;
  consultants: DelegationConsultant[];
  signals: DelegationSignal[];
}

export type ReadinessStepId = "runtime" | "connection" | "teammate";

export interface ReadinessStep {
  id: ReadinessStepId;
  ready: boolean;
  label: string;
  detail: string;
}

/** First-run setup state: what a fresh owner still needs for a working studio. */
export interface Readiness {
  ready: boolean;
  steps: ReadinessStep[];
}

export interface RunReceiptCheck {
  label: string;
  passed: boolean;
  source: "host" | "teammate";
  detail: string | null;
}

export interface RunReceiptEntry {
  botName: string;
  role: string | null;
  model: string | null;
  status: RunStatus;
  tokens: number;
  cost: number;
}

export interface RunReceiptWorkLog {
  label: string;
  detail: string | null;
  at: string;
}

export interface RunReceiptArtifact {
  name: string;
  mime: string;
  revision: number;
  url: string | null;
  /** deliverable = user-facing result; evidence = host receipts/usage;
   * internal = scratch. Only deliverables may satisfy a required deliverable. */
  classification: "deliverable" | "evidence" | "internal";
}

export interface RunReceiptExternalAction {
  label: string;
  status: ApprovedActionStatus;
  detail: string | null;
}

/** A host-recorded account of one job, with explicit evidence provenance
 * and uncertainty. Not a cryptographic signature or a guarantee of success. */
export interface RunReceipt {
  runId: string;
  threadId: string;
  botName: string;
  goal: string | null;
  deliverable: string | null;
  status: RunStatus;
  /** Task outcome, separate from process status (see Run.outcome). */
  outcome: "delivered" | "blocked" | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  team: RunReceiptEntry[];
  checks: RunReceiptCheck[];
  workLog: RunReceiptWorkLog[];
  /** Input files retained for this task (never deleted on stop). */
  inputs: RunReceiptArtifact[];
  artifacts: RunReceiptArtifact[];
  externalActions: RunReceiptExternalAction[];
  uncertainty: string[];
  usage: { tokens: number; cost: number; runs: number };
}

export interface Run {
  /** Host-bound owner-requested review. Identity is a delivered revision, not a filename. */
  review?: {
    artifacts: Array<{ id: string; name: string; revision: number; sha256: string }>;
  } | null;
  expectedWorkKind?: "morning" | "inbox" | "meeting" | "weekly" | null;
  completionRepairCount?: number;
  id: string;
  threadId: string;
  botId: string;
  botName: string;
  botEmoji: string;
  botMascot: MascotKind;
  botColor: string;
  parentRunId: string | null;
  /** Starts after this run answers (a later teammate building on its work). */
  afterRunId?: string | null;
  steeredFromRunId: string | null;
  /** Task outcome, separate from process status: a run whose process ended
   * is "completed", but only "delivered" means the requested work exists.
   * "blocked" means it stopped without delivering (e.g. inputs never became
   * usable output); null means no deliverable was checked. */
  outcome?: "delivered" | "blocked" | null;
  /** Group-discipline linkage: the teammate reply that @mentioned this run
   * into the conversation. Lets the follow-up quote its trigger and keeps the
   * reply chain (and its round cap) computable from host records. */
  triggerMessageId?: string | null;
  routineId: string | null;
  automationEventId: string | null;
  attemptCount: number;
  recoveredAt: string | null;
  consultationPending: boolean;
  attachmentIds: string[];
  prompt: string;
  status: RunStatus;
  approvalReason: string | null;
  approvalId: string | null;
  partialText: string | null;
  modelOverride: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  progressAt: string | null;
  summary: string | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  /** Fresh input a provider stored for re-reading later (Claude's prompt cache). */
  cacheWriteTokens: number;
  cost: number;
  activities: Activity[];
  activeDurationMs: number;
  modelSteps: number;
  task: TaskContract;
}

export interface Approval {
  id: string;
  runId: string;
  botId: string;
  botName: string;
  kind: "prompt" | "terminal" | "browser" | "external" | "budget";
  /** Presentation hint only; a browser click is not a sign-in handoff. */
  requiresSignIn?: boolean;
  reason: string;
  actionLabel: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  decidedAt: string | null;
}

export type ApprovedActionStatus =
  | "prepared"
  | "running"
  | "completed"
  | "failed"
  | "uncertain"
  | "confirmed_completed"
  | "confirmed_not_completed";

export interface ApprovedActionReceipt {
  id: string;
  approvalId: string;
  runId: string;
  botId: string;
  botName: string;
  actionType: string;
  actionLabel: string;
  status: ApprovedActionStatus;
  attemptCount: number;
  resultSummary: string | null;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  reviewedAt: string | null;
}

export type AutomationTriggerType = "schedule" | "webhook" | "github" | "calendar" | "todoist" | "dropbox" | "slack" | "notion" | "webpage";

export interface RoutineTriggerConfig {
  pageUrl?: string;
  pageSelector?: string;
  eventName?: string;
  githubEvent?: string;
  githubAction?: string;
  repository?: string;
  titleContains?: string;
  minutesBefore?: number;
  todoistEvent?: "added" | "updated" | "completed" | "any";
  dropboxPath?: string;
  slackEvent?: "mention" | "message" | "reaction" | "any";
  slackChannel?: string;
  notionEvent?: "page_updated" | "page_created" | "comment" | "database" | "any";
  notionEntityId?: string;
}

export interface Routine {
  schedule?: RoutineSchedule;
  scheduleLabel?: string;
  watchStatus?: { state: "baseline" | "unchanged" | "changed" | "error"; checkedAt: string; nextCheckAt: string; checks: number; unchangedChecks: number; detail: string };
  id: string;
  name: string;
  botId: string;
  botName: string;
  botEmoji: string;
  threadId: string;
  prompt: string;
  cadence: "hourly" | "daily";
  intervalMinutes: number;
  triggerType: AutomationTriggerType;
  triggerConfig: RoutineTriggerConfig;
  hasWebhookSecret: boolean;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "never" | "completed" | "failed";
  runCount: number;
  consecutiveFailures: number;
  deduplicatedCount: number;
  lastError: string | null;
  pausedReason: string | null;
  /** Optimistic-concurrency guard (P03b). Every mutation bumps it; callers
   * pass the revision they listed and a mismatch is a 409, never a silent
   * overwrite. Native readers ignore it until they adopt it. */
  revision: number;
  lastSuccessAt: string | null;
  lastEventAt: string | null;
}

export type AutomationEventStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "rate_limited";

export interface AutomationEvent {
  id: string;
  routineId: string;
  routineName: string;
  botId: string;
  botName: string;
  source: AutomationTriggerType | "manual";
  externalId: string;
  status: AutomationEventStatus;
  runId: string | null;
  replayOfEventId: string | null;
  payloadSummary: string;
  receivedAt: string;
  finishedAt: string | null;
  error: string | null;
  attempt: number;
  repairHint: string | null;
}

export interface AutomationAlert {
  id: string;
  routineId: string;
  routineName: string;
  runId: string | null;
  eventId: string | null;
  kind: "missed" | "failure" | "approval" | "rate_limit";
  message: string;
  repairHint: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export type RunnerStatus = "online" | "recovering" | "offline";
export type BackgroundServiceStatus = "installed" | "not_installed" | "unsupported";
export type DeploymentMode = "local" | "private_runner";

export interface DeploymentCheck {
  id: "https" | "storage" | "access" | "runner";
  label: string;
  status: "ready" | "action";
  detail: string;
}

export interface DeploymentStatus {
  mode: DeploymentMode;
  label: string;
  alwaysOn: boolean;
  publicUrl: string | null;
  dataLocation: "this_mac" | "private_volume";
  checks: DeploymentCheck[];
}

export interface RunnerHealth {
  status: RunnerStatus;
  mode: "foreground" | "background";
  instanceId: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  lastCycleAt: string | null;
  recoveredRuns: number;
  dispatchedRuns: number;
  queuedRuns: number;
  runningRuns: number;
  waitingRuns: number;
  nextRoutineAt: string | null;
  lastError: string | null;
  backgroundService: BackgroundServiceStatus;
  backgroundServiceDetail: string;
  deployment?: DeploymentStatus;
}

export interface RunnerCareCheck {
  id: "storage" | "backup" | "software" | "opencode" | "browser" | "computers";
  label: string;
  status: "ready" | "attention";
  value: string;
  detail: string;
}

export interface RunnerHealthAlerts {
  enabled: boolean;
  intervalMinutes: number;
  destinationCount: number;
  deliveryReady: boolean;
  lastCheckedAt: string | null;
  lastNotifiedAt: string | null;
  lastStatus: "ready" | "attention" | null;
}

export interface RunnerExternalHeartbeat {
  configured: boolean;
  enabled: boolean;
  intervalMinutes: number;
  provider: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface RunnerCareSnapshot {
  checkedAt: string;
  mode: DeploymentMode;
  version: string;
  uptimeSeconds: number;
  publicUrl: string | null;
  dataPath: string;
  overall: "ready" | "attention";
  summary: string;
  checks: RunnerCareCheck[];
}

export interface RunnerCareStatus extends RunnerCareSnapshot {
  alerts: RunnerHealthAlerts;
  heartbeat: RunnerExternalHeartbeat;
}

export type ProviderKind = "opencode" | "claude" | "openai" | "github-copilot" | "gitlab" | "xai" | "google" | "apple" | "custom";
export type ProviderRuntime = "opencode" | "claude_code" | "apple_fm";

export interface ApiConnectionConfig {
  baseUrl: string;
  protocol: "openai-compatible" | "openai" | "anthropic";
  modelIds: string[];
}

export interface ProviderInstance {
  id: string;
  ownerId: string;
  provider: ProviderKind;
  name: string;
  authMode: "cli" | "subscription" | "api_key";
  runtime: ProviderRuntime;
  envName: string | null;
  hasSecret: boolean;
  apiConfig?: ApiConnectionConfig | null;
  createdAt: string;
  updatedAt: string;
  connected?: boolean;
  models?: string[];
  defaultModel?: string;
  note?: string;
}

export interface ProviderCatalogEntry {
  id: Exclude<ProviderKind, "custom">;
  name: string;
  shortName: string;
  description: string;
  badge: string;
  connected: boolean;
  installed: boolean;
  canConnect: boolean;
  connectionId: string | null;
  models: string[];
  note: string;
}

export interface ProviderLoginAttempt {
  id: string;
  providerId: string;
  status: "waiting" | "connected" | "failed";
  url: string | null;
  callbackMode: "auto" | "code" | null;
  instructions: string;
  error: string | null;
}

/** A persisted live connection-test receipt. Absence means "Saved, not tested":
 * saved credentials alone are never reported as ready. */
export interface ProviderConnectionTest {
  tested: true;
  ok: boolean;
  model: string;
  latencyMs: number;
  error: string | null;
  testedAt: string;
}

export interface ProviderStatus {
  id: "opencode";
  name: string;
  connected: boolean;
  cliAvailable: boolean;
  version: string | null;
  defaultModel: string;
  models: string[];
  note: string;
  instances: ProviderInstance[];
  catalog: ProviderCatalogEntry[];
  loginAttempts: ProviderLoginAttempt[];
}

export type ConnectorKind = "google_workspace" | "github_cli" | "slack_oauth" | "notion_oauth" | "todoist_oauth" | "dropbox_oauth";
export type ConnectorServiceId = "gmail" | "google-drive" | "google-calendar" | "slack" | "notion" | "github" | "todoist" | "dropbox";
export type GoogleConnectorService = "gmail" | "google-drive" | "google-calendar";

export interface ConnectorManifest {
  schemaVersion: 2;
  connectorId: string;
  service: ConnectorServiceId;
  name: string;
  description: string;
  auth: "oauth" | "local_cli";
  readCapability: string;
  writeCapability: string | null;
  writeRequiresApproval: boolean;
  eventCapability: string | null;
  eventAuth: "provider_hmac" | "signed_secret" | "cursor" | null;
  dataBoundary: string;
  docsUrl: string;
}

export interface ConnectorConnection {
  id: string;
  ownerId: string;
  kind: ConnectorKind;
  name: string;
  configured: boolean;
  connected: boolean;
  accountEmail: string | null;
  scopes: string[];
  status: "unconfigured" | "configured" | "connected" | "needs_attention";
  lastError: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BotConnectorAccess {
  botId: string;
  connectorId: string;
  service: ConnectorServiceId;
  canRead: boolean;
  canSend: boolean;
  updatedAt: string;
}

export interface ConnectorEvent {
  id: string;
  connectorId: string;
  botId: string | null;
  botName: string | null;
  action: string;
  status: "completed" | "failed" | "waiting";
  summary: string;
  createdAt: string;
}

export interface ConnectorCatalogEntry {
  id: ConnectorServiceId;
  connectorId?: string;
  manifestVersion?: 2;
  name: string;
  description: string;
  badge: string;
  availability: "live" | "next";
  connected: boolean;
  writeConnected?: boolean;
  writeRequiresApproval?: boolean;
  capabilities: string[];
}

export interface OAuthConnectorStatus {
  connectorId: "slack" | "notion" | "todoist" | "dropbox";
  configured: boolean;
  connected: boolean;
  managedClient: boolean;
  oauthInProgress: boolean;
  callbackUrl: string;
  accountName: string | null;
  lastError: string | null;
  events?: {
    url: string;
    secretConfigured: boolean;
    verified: boolean;
    verificationTokenReady: boolean;
  };
}

export interface SlackMessageSummary {
  channelId: string;
  channelName: string;
  timestamp: string;
  threadTimestamp: string | null;
  author: string;
  text: string;
  permalink: string | null;
}

export interface SlackConversationResult {
  channelId: string;
  messages: SlackMessageSummary[];
}

export interface NotionPageSummary {
  id: string;
  title: string;
  url: string;
  lastEditedAt: string;
}

export interface NotionPageDetail extends NotionPageSummary {
  content: string;
  truncated: boolean;
}

export interface TodoistTaskSummary {
  id: string;
  content: string;
  description: string;
  projectId: string;
  priority: number;
  due: string | null;
  completed: boolean;
  url: string;
}

export interface DropboxFileSummary {
  id: string;
  path: string;
  name: string;
  modifiedAt: string;
  size: number;
  isDownloadable: boolean;
  webUrl: string | null;
}

export interface DropboxFileDetail extends DropboxFileSummary {
  content: string;
  truncated: boolean;
}

export interface GoogleApiRecovery {
  service: "gmail" | "google-drive" | "google-calendar";
  serviceName: string;
  projectId: string;
  enableUrl: string;
}

export interface ConnectorStatus {
  connection: ConnectorConnection | null;
  connections: ConnectorConnection[];
  manifests: ConnectorManifest[];
  callbackUrl: string;
  managedGoogleClient: boolean;
  oauthInProgress: boolean;
  googleProjectId: string | null;
  googleApiRecovery: GoogleApiRecovery | null;
  googleApiRecoveries: GoogleApiRecovery[];
  localApps?: { available: boolean; enabled: boolean; readServices: string[] };
  github: GitHubConnectorStatus;
  slack: OAuthConnectorStatus;
  notion: OAuthConnectorStatus;
  todoist: OAuthConnectorStatus;
  dropbox: OAuthConnectorStatus;
  catalog: ConnectorCatalogEntry[];
  access: BotConnectorAccess[];
  events: ConnectorEvent[];
}

export interface GitHubConnectorStatus {
  installed: boolean;
  connected: boolean;
  connecting: boolean;
  accountLogin: string | null;
  lastError: string | null;
}

export interface GitHubNotificationSummary {
  id: string;
  repository: string;
  title: string;
  type: string;
  reason: string;
  unread: boolean;
  updatedAt: string;
  url: string | null;
}

export interface GitHubIssueSummary {
  id: string;
  number: number;
  repository: string;
  title: string;
  state: "open" | "closed";
  author: string | null;
  labels: string[];
  updatedAt: string;
  url: string;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface GmailMessageDetail extends GmailMessageSummary {
  body: string;
}

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink: string;
  size: number | null;
}

export interface DriveFileDetail extends DriveFileSummary {
  content: string;
}

export interface CalendarEventSummary {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  webLink: string;
  attendeeCount: number;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** What the weekly counters show: fresh tokens in full, cached re-reading at a tenth. */
  totalTokens: number;
  cost: number;
  completedRuns: number;
  activeRuns: number;
}

export interface ComputerStatus {
  botId: string;
  container: "ready" | "stopped" | "unavailable";
  browser: "ready" | "stopped" | "unavailable";
  currentUrl: string | null;
  title: string | null;
  screenshot: string | null;
  updatedAt: string;
}

export interface TaughtWorkflow {
  id: string;
  botId: string;
  botName: string;
  name: string;
  skillSlug: string;
  description: string;
  instructions: string;
  startUrl: string;
  stepCount: number;
  version: number;
  /** Turned off by the owner: not routable, and its skill files are removed
   * from the teammate's harness directories. */
  disabled?: boolean;
  source: "taught" | "imported" | "template" | "assigned" | "proposed";
  createdAt: string;
  updatedAt: string;
}

export interface SkillStep {
  type: "navigate" | "click" | "input" | "submit";
  url: string;
  selector?: string;
  value?: string;
  label?: string;
}

export interface SkillVersion {
  id: string;
  workflowId: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  startUrl: string;
  stepCount: number;
  createdAt: string;
}

export interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  instructions: string;
  startUrl: string;
  category: string;
  stepCount: number;
}

export interface CodeProjectAccess {
  botId: string;
  projectId: string;
  canRead: boolean;
  canWrite: boolean;
  canRun: boolean;
  updatedAt: string;
}

export interface CodeProject {
  id: string;
  ownerId: string;
  name: string;
  rootPath: string;
  gitRepository: boolean;
  projectKind: string;
  remoteUrl: string | null;
  defaultBranch: string | null;
  managedClone: boolean;
  access: CodeProjectAccess[];
  createdAt: string;
  updatedAt: string;
}

export interface CodeProjectEdit {
  id: string;
  projectId: string;
  botId: string;
  botName: string;
  path: string;
  operation: "created" | "updated";
  additions: number;
  deletions: number;
  workspaceRunId: string | null;
  reversible: boolean;
  restoredAt: string | null;
  createdAt: string;
}

export interface CodeTaskWorkspace {
  runId: string;
  projectId: string;
  projectName: string;
  botId: string;
  botName: string;
  branch: string;
  rootPath: string;
  status: "active" | "published" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface CodeTaskReview {
  id: string;
  sourceRunId: string;
  reviewerRunId: string;
  projectId: string;
  reviewerBotId: string;
  reviewerBotName: string;
  verdict: "approved" | "changes_requested";
  summary: string;
  findings: string[];
  headCommit: string;
  createdAt: string;
}

export interface CodeProjectReview {
  projectId: string;
  gitRepository: boolean;
  branch: string | null;
  defaultBranch: string | null;
  remoteUrl: string | null;
  workspace: CodeTaskWorkspace | null;
  changes: string[];
  diff: string;
  truncated: boolean;
}

export interface CodeProjectSuggestion {
  name: string;
  rootPath: string;
  gitRepository: boolean;
  projectKind: string;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  modifiedAt: string;
  kind: "file" | "directory";
}

export interface StudioSettings {
  macAccessEnabled: boolean;
  semanticBrowserEnabled: boolean;
  selfExtendEnabled: boolean;
  codingModel: string | null;
  embeddingsProviderInstanceId: string | null;
  embeddingsModel: string | null;
  maxTeammates: number;
  yoloMode: boolean;
}

export interface StudioDraft {
  threadId: string;
  body: string;
  source: "web" | "ios" | "macos" | null;
  updatedAt: string | null;
}

export interface AppState {
  /** The last 7 days of finished work, when there is any (see weekly-recap). */
  weeklyRecap?: import("./weekly-recap").WeeklyRecap | null;
  /** How many "Waiting for you" cards need a decision. */
  queueReady?: number;
  /** True only in a demo studio: Waiting for you answers with sample results and touches nothing. */
  demoMac?: boolean;
  bots: Bot[];
  threads: Thread[];
  messages: Message[];
  runs: Run[];
  studioRuns: Run[];
  routines: Routine[];
  automationEvents: AutomationEvent[];
  automationAlerts: AutomationAlert[];
  runner: RunnerHealth;
  workflows: TaughtWorkflow[];
  approvals: Approval[];
  approvedActions: ApprovedActionReceipt[];
  agentMessages: AgentMessage[];
  delegations: Delegation[];
  retiredBots: Bot[];
  providers: ProviderInstance[];
  settings: StudioSettings;
  draft: StudioDraft;
  usage: UsageSummary;
  activeThreadId: string;
}

/** One card in "Waiting for you": something a teammate prepared that a person approves, skips or undoes. */
export interface QueueCard {
  id: string;
  kind: "reminder" | "calendar_event" | "reply_draft" | "file_attachment";
  status: "ready" | "done" | "skipped" | "undone" | "failed" | "expired";
  title: string;
  why: string;
  preview: string;
  action: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  undoneAt: string | null;
  botId: string | null;
  meta?: Record<string, string> | null;
}

/** The month's filed receipts, for the accountant. */
export interface ReceiptsSummary {
  month: string; months: string[];
  rows: Array<{ filedAt: string; vendor: string; invoiceDate: string; reference: string; amount: string; currency: string; file: string; savedTo: string }>;
  totals: Array<{ currency: string; amount: string; count: number }>; withoutAmount: number;
}

/** "You approved this kind of thing five times in a row. Do it automatically?" */
export interface QueueOffer { pattern: string; kind: QueueCard["kind"]; label: string; approvals: number; }
/** A standing yes to one narrow pattern. Paused means it waits for a person again. */
export interface QueueRuleCard { id: string; kind: QueueCard["kind"]; label: string; status: "active" | "paused"; pausedReason: string | null; uses: number; lastUsedAt: string | null; }
