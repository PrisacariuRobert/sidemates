import { ShareResultSheet } from "../components/ShareResultSheet";
import { AUTOPILOT_WARNING } from "../shared/autopilot";
import { SidebarExtras } from "../components/SidebarExtras";
import type { Attachment } from "../shared/types";
import { DocumentPane } from "./DocumentPane";
import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type CSSProperties,
} from "react";
import { flushSync } from "react-dom";
import { createSpring, rubberband } from "./spring";
import {
  Activity,
  ArrowRight,
  Boxes,
  Files,
  FolderGit2,
  Moon,
  Smartphone,
  Sparkles,
  Sun,
  WandSparkles,
  ArrowRightLeft,
  ArrowUp,
  Archive,
  AudioLines,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  Layers3,
  LoaderCircle,
  MessageCircle,
  Monitor,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  ShieldQuestion,
  SlidersHorizontal,
  Undo2,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import { BrowserSignInPanel } from "../components/BrowserSignInPanel";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Temporal } from "@js-temporal/polyfill";
import { calendarMonthDays } from "../shared/calendar-grid";
import { activeNowBots } from "../shared/presence";
import { friendlyModelName } from "../shared/provider-config";
import { ModelPicker, useProviderStatus } from "../components/ModelPicker";
import type {
  AppState,
  Bot,
  ConnectorCatalogEntry,
  ConnectorStatus,
  Message,
  Run,
  Routine,
  Thread,
} from "../shared/types";
import type { CommunitySkill } from "../shared/extensions";
import { ConnectorIcon } from "../ConnectorIcon";
import { Character, setAvatars } from "./Character";
import { CreateTeammate } from "./CreateTeammate";
import { WeeklyRecapEntry } from "./WeeklyRecap";
import { WaitingEntry, WaitingForYou } from "./WaitingForYou";
import { VoiceMode, voiceModeSupported } from "./VoiceMode";
import { startersFor } from "./starters";
import { FirstRun } from "./FirstRun";
import { StopFix } from "./StopFix";
import { SkillDiscover, SkillDiscoverDetail, type CatalogEntry } from "./SkillDiscover";
import { ConversationContext } from "./ConversationContext";
import { ConversationActions } from "./ConversationActions";
import { ComputerTakeover } from "./LiveComputer";
import { GroupEditor } from "./GroupEditor";
import { AutoReviewRules } from "./AutoReviewRules";
import { useConversationDraft } from "./useConversationDraft";
import { conversationMatches, recentTeammates } from "./conversation-filter";
import { privacyPaneIn } from "../shared/recovery";
import { selectPendingSignIn } from "./signin-pane";
import { MessageControls } from "./MessageControls";
import { ApiError, apiError, createSubmissionKeys } from "./submission-keys";
import { useConversationAttachments } from "./useConversationAttachments";
import { RunControls } from "./RunControls";
import { ConversationProgress } from "./ConversationProgress";
import { DeliveryReceipt, DeliveredFile, DeliveryCard } from "./DeliveryReceipt";
import { WorkReceipt } from "../CapabilityPanels";
import { cancelledRunForTrigger, latestCancelledWithoutTrigger } from "./cancelled-run-outcome";
import { groupConsecutiveActionEvents, groupConsecutiveRoutineRuns } from "./action-event-groups";
import { useAgentsToBringOver } from "../components/ExistingAgentsCard";
import { DictationButton, dictationSupported } from "../components/Dictation";
import { tasksNeedingOwner } from "./attention";
import { MarkdownMessage } from "../MarkdownMessage";
import { ChoiceMenu } from "./ChoiceMenu";
import { Advanced } from "./Advanced";
import { SettingsGroup, SettingsCard, SettingsNavRow, SegmentedControl } from "./Settings";
import { AppearanceEditor } from "./AppearanceEditor";
import { useAppearance, type Appearance } from "./useAppearance";
import { fileLabel, fileSiglaClass } from "./file-glyph";
import { foldTalkingPills } from "./talk-folds";
import "./character-context.css";
import { capabilityTitles, isCapabilityPanel, type CapabilityPanel } from "./capability-navigation";
const CapabilityPanelHost = lazy(() => import("./CapabilityPanelHost").then((module) => ({ default: module.CapabilityPanelHost })));

type Page = "home" | "waiting" | "activity" | "schedule" | "library" | "chat" | "settings";
type Detail =
  | { kind: "new" }
  | { kind: "create" }
  | { kind: "group"; threadId: string }
  | { kind: "workspace" }
  | { kind: "context" }
  | { kind: "teammate"; bot: Bot }
  | { kind: "run"; run: Run }
  | { kind: "app"; app: ConnectorCatalogEntry }
  | { kind: "skill"; skill: CommunitySkill }
  | { kind: "discover"; entry: CatalogEntry }
  | { kind: "settings" }
  | { kind: "search" };
const activeStates = ["running", "queued", "waiting_for_teammate"];
const labelFor = (status: string) =>
  ({
    running: "Working",
    queued: "Up next",
    waiting_for_teammate: "Consulting the team",
    awaiting_approval: "Needs your review",
    completed: "Finished",
    failed: "Needs a hand",
    cancelled: "Stopped",
  })[status] || status;
const dayKey = (date: string | number | Date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** Sidebar grouping, the way a messages list reads: Today, Yesterday, then
 * everything older. Rows keep the order they arrive in. */
const conversationDayGroup = (date: string | null | undefined, now = new Date()) => {
  if (!date) return "Earlier";
  const key = dayKey(date);
  if (key === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return key === dayKey(yesterday) ? "Yesterday" : "Earlier";
};
const timeText = (date: string) =>
  new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dateText = (date: string) =>
  new Date(date).toLocaleDateString([], { month: "short", day: "numeric" });
/** A teammate that needs the Mac's files asks in words; this turns that into
 * one tap: switch on Files & apps for the studio, then tell it to go ahead.
 * The tap itself is the owner's decision; nothing runs before it. */
function MacAccessOffer({ name, threadId, onDone }: { name: string; threadId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const turnOn = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ macAccessEnabled: true }) });
      if (!response.ok) throw new Error("Files & apps couldn't be turned on. Try Control center.");
      await api("/api/messages", { threadId, body: "I turned on Files & apps on this Mac — go ahead.", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, requestId: crypto.randomUUID() });
      onDone();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Something went wrong."); setBusy(false); }
  };
  return (
    <div className="mac-access-offer">
      <button type="button" className="text-action strong" disabled={busy} onClick={() => void turnOn()}>{busy ? "Turning on…" : `Turn on Files & apps for ${name}`}</button>
      <small>Lets your teammates use your Mac’s folders and apps. Changes still ask you first. You can turn it off in Control center.</small>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    signal,
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (response.status === 401) {
    window.dispatchEvent(new Event("openbot:locked"));
    throw new Error(
      "This studio is locked. Unlock it to continue.",
    );
  }
  const result = await response.json();
  if (!response.ok)
    throw apiError(
      response.status,
      result,
      "That didn’t work. Please try again.",
    );
  return result as T;
}
function Face({
  bot,
  size = 38,
}: {
  bot: Pick<Bot, "name" | "color" | "mascot" | "status">;
  size?: number;
}) {
  return (
    <Character
      name={bot.name}
      color={bot.color}
      variant={bot.mascot}
      status={bot.status}
      size={size}
    />
  );
}
function FaceGroup({ bots, size = 50 }: { bots: Bot[]; size?: number }) {
  return (
    <div className="faces">
      {bots.slice(0, 3).map((bot) => (
        <Face key={bot.id} bot={bot} size={size} />
      ))}
    </div>
  );
}
function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-rule" />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
function CancelledRunOutcome({ run, onReview, dated = false }: { run: Run; onReview: () => void; dated?: boolean }) {
  return <div className="chat-event cancelled-run-outcome" role="status" data-event="run_stopped">
    <span className="chat-event-mark" aria-hidden="true"><MessageCircle size={14} /></span>
    <span><strong>{run.botName} · Stopped{dated && run.finishedAt ? ` · ${dateText(run.finishedAt)}` : ""}</strong><button type="button" className="text-action" onClick={onReview}>Review saved progress</button></span>
  </div>;
}
function eventTitle(message: Message): string {
  const data = message.eventData || {};
  switch (message.eventType) {
    case "run_stopped":
      return String(data.title || (data.botName ? `${data.botName} stopped` : "Task stopped"));
    case "action_completed":
      return String(data.title || "Task update");
    case "routine_created":
      return `Created Routine ${data.name ?? message.body}`;
    case "routine_run":
      return `${data.name ?? "Routine"} started`;
    case "handoff":
      return `${data.fromName ?? "Teammate"} asked ${data.toName ?? "a teammate"}`;
    case "teammate_message":
      return `${data.fromName ?? "Teammate"} ${data.expectsReply === "true" ? "asked" : "messaged"} ${data.toName ?? "a teammate"}`;
    default:
      return "Studio event";
  }
}
/** Group membership events read as noise in bubbles and lists — they render
 * as centered system pills and member names instead. */
function isMembershipText(text: string): boolean {
  const clean = text.replace(/[*#_`]/g, "");
  return (
    clean.startsWith('The group "') ||
    /joined|left the group|now has .* in it\.?$/.test(clean)
  );
}
/** Machine markers (ROUTINE_HEARTBEAT_OK and friends) read as status codes,
 *  not conversation. Humanize one for a quiet system line, or null. */
function machineMarkerText(body: string): string | null {
  const match = /^\s*ROUTINE_([A-Z0-9_]+)\s*$/.exec(body || "");
  if (!match) return null;
  const words = match[1]!.toLowerCase().split("_");
  return words
    .map((word, index) =>
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    )
    .join(" ");
}
/** Faces for an event pill: everyone the event names, de-duplicated. */
function resolveEventFaces(
  data: Record<string, string | number | boolean | null>,
  bots: Bot[],
  max: number,
): Bot[] {
  const found: Bot[] = [];
  const push = (candidate?: Bot) => {
    if (candidate && !found.some((face) => face.id === candidate.id)) found.push(candidate);
  };
  const byId = data.botId;
  if (typeof byId === "string" && byId) push(bots.find((bot) => bot.id === byId));
  for (const key of ["fromName", "toName", "botName"]) {
    const name = data[key];
    if (typeof name === "string" && name) push(bots.find((bot) => bot.name === name));
  }
  return found.slice(0, max);
}
/** One talking pill: faces + title, detail behind an inline chevron. */
function TalkPill({
  faces,
  title,
  lines,
  meta,
}: {
  faces: Bot[];
  title: string;
  lines: string[];
  meta?: string;
}) {
  const row = (
    <>
      <span className="chat-event-mark" aria-hidden="true">
        {faces.length > 0 ? (
          faces.map((face) => <Face key={face.id} bot={face} size={20} />)
        ) : (
          <MessageCircle size={14} />
        )}
      </span>
      <span>
        <strong>{title}</strong>
        {meta && <small>{meta}</small>}
      </span>
    </>
  );
  if (!lines.length) return <div className="chat-event talk-pill">{row}</div>;
  return (
    <div className="chat-event talk-pill">
      <details>
        <summary>
          {row}
          <ChevronDown size={13} aria-hidden="true" />
        </summary>
        <div className="talk-lines">
          {lines.map((line, index) => (
            <small key={index}>{line}</small>
          ))}
        </div>
      </details>
    </div>
  );
}
function eventDetail(message: Message): string {
  const data = message.eventData || {};
  switch (message.eventType) {
    case "run_stopped": {
      // The pill carries title + action on one line. The server paragraph
      // only shows when the title itself says nothing ("Work stopped").
      const rawTitle = String(message.eventData?.title || "");
      if (rawTitle && !/^(Task update|Studio event|Work stopped)$/.test(rawTitle)) return "";
      // The body leads with "<Bot>: " — the face already says who.
      const sentence = message.body.replace(/^[^:.]{1,40}:\s*/, "").split(". ")[0]!.trim();
      const line = sentence.endsWith(".") ? sentence : `${sentence}.`;
      return line.length > 140 ? `${line.slice(0, 137)}…` : line;
    }
    case "routine_created":
      return `${data.schedule ?? ""}${data.enabled === "false" ? " · Paused" : ""}`;
    case "routine_run":
      return `${data.source === "manual" ? "Test run" : `From ${data.source ?? "schedule"}`}${data.waiting === "true" ? " · Needs your okay" : ""}`;
    case "handoff":
      return String(data.task ?? message.body).replace(/\s+/g, " ").trim();
    case "teammate_message":
      return data.expectsReply === "true" ? "Reply requested" : "Update shared";
    case "action_completed":
      // The face shows who; the task view keeps the full record with links.
      return message.body.replace(/^[^:.]{1,40}:\s*/, "").replace(/\s*\(https?:\/\/[^)\s]+\)/g, "").trim();
    default:
      return message.body;
  }
}



/** Starters fill the message box without sending, so a blank page never
 * has to be solved alone. Shown until the owner sends a first message. */
function ChatStarters({ onPick, jobs, mac = false }: { onPick: (text: string) => void; jobs: string[]; mac?: boolean }) {
  return <div className="chat-starters" aria-label="Ideas to start with">
    {startersFor(jobs, mac).map((starter) => (
      <button key={starter.label} type="button" className="chat-starter" onClick={() => onPick(starter.text)}>
        <strong>{starter.label}</strong>
        <span>{starter.hint}</span>
      </button>
    ))}
  </div>;
}

const SETTINGS_CATEGORIES: ReadonlyArray<{
  title: string;
  items: ReadonlyArray<{
    id: CapabilityPanel;
    title: string;
    description: string;
    icon: typeof Sparkles;
    badge?: (state: AppState) => string | undefined;
    badgeVariant?: (state: AppState) => "neutral" | "success" | "warning";
    keywords: ReadonlyArray<string>;
  }>;
}> = [
{ title: "Team", items: [
{ id: "team", title: "Your team", description: "A few useful personalities. One familiar place to work.", icon: UsersRound, keywords: ["teammates", "import", "restore"] },
{ id: "bot", title: "Teammate settings", description: "Personality, instructions, access and limits.", icon: UsersRound, keywords: ["bot", "edit", "personality"] },
{ id: "teach", title: "Memory & skills", description: "Useful context. Reusable know-how.", icon: WandSparkles, keywords: ["teach", "recipes", "mcp", "learn", "memory"] },
{ id: "knows", title: "What they know", description: "Choose what your team can search on this Mac.", icon: Search, keywords: ["index", "search", "notes", "mail", "files", "private", "forget", "messages"] },
{ id: "routines", title: "Automations", description: "Useful work that comes back to you. Easy to adjust; easy to pause.", icon: Clock, keywords: ["schedule", "watcher", "cron", "routine"] }
]},
{ title: "Connections", items: [
{ id: "provider", title: "Your AI", description: "Choose the connection. Keep the conversation.", icon: Sparkles, keywords: ["models", "provider", "api key", "account", "local"] },
{ id: "connectors", title: "Apps & tools", description: "Familiar tools. Clear boundaries.", icon: Boxes, keywords: ["google", "slack", "notion", "github", "connectors", "mcp"] },
{ id: "telegram", title: "Chat apps", description: "iMessage, Telegram and Discord: ask from the app you already use.", icon: Send, keywords: ["imessage", "messages", "sms", "telegram", "discord", "chat", "message", "channel", "bot", "phone"] },
{ id: "remote", title: "Your phone", description: "The same conversations, wherever you are.", icon: Smartphone, keywords: ["remote", "away", "pair", "https"] }
]},
{ title: "Work", items: [
{ id: "projects", title: "Projects", description: "Real changes, with room to review.", icon: FolderGit2, keywords: ["git", "code", "worktree"] },
{ id: "artifacts", title: "Files & results", description: "What came back, and the source it came from.", icon: FileText, keywords: ["documents", "deliverables", "revisions"] },
{ id: "files", title: "Private files", description: "Inspect their workspace without widening access.", icon: Files, keywords: ["scratchpad", "files"] },
{ id: "computer", title: "Computer", description: "A private workspace with visible boundaries.", icon: Monitor, keywords: ["browser", "container", "desktop"] }
]},
{ title: "Trust & usage", items: [
{ id: "control", title: "Permissions", description: "Clear boundaries make the helpful part easier.", icon: ShieldCheck, keywords: ["safety", "mac access", "yolo", "security"] },
{ id: "usage", title: "Usage & limits", description: "A clear budget. An honest stopping point.", icon: Activity, keywords: ["tokens", "cost", "budget", "allowance"] },
{ id: "live", title: "Activity & recovery", description: "Know what happened. Choose what happens next.", icon: Activity, keywords: ["audit", "receipt", "recovery"] }
]}];

function SettingsWorkspacePage({
  activePanel,
  setActivePanel,
  state,
  thread,
  appearance,
  setAppearance,
  onOpenCapability,
  onThread,
  onRefresh,
  onCreate,
}: {
  onCreate: () => void;
  activePanel: CapabilityPanel;
  setActivePanel: (panel: CapabilityPanel) => void;
  state: AppState;
  thread: string;
  appearance: Appearance;
  setAppearance: (next: Appearance) => void;
  onOpenCapability: (panel: CapabilityPanel | null, targetThread?: string) => void;
  onThread: (id: string) => void;
  onRefresh: () => void;
}) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [mobileMode, setMobileMode] = useState<"menu" | "detail">("detail");

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const allItems = useMemo(() => SETTINGS_CATEGORIES.flatMap((c) => c.items), []);
  const activeItem = allItems.find((item) => item.id === activePanel) || allItems[0];

  const q = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!q) return [];
    return allItems.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.keywords.some((k) => k.includes(q)),
    );
  }, [allItems, q]);

  const selectItem = (id: CapabilityPanel) => {
    setActivePanel(id);
    setMobileMode("detail");
  };

  return (
    <div className={`settings-page-layout mobile-mode-${mobileMode}`}>
      <aside className="settings-page-sidebar">
        <div className="settings-sidebar-search">
          <div className="settings-search-bar" style={{ height: 34, padding: "0 10px" }}>
            <Search size={14} className="settings-search-icon" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search settings"
              className="settings-search-input"
              style={{ fontSize: 12 }}
            />
            {query ? (
              <button
                type="button"
                className="settings-search-clear"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
              >
                <X size={11} />
              </button>
            ) : (
              <kbd className="settings-search-kbd">/</kbd>
            )}
          </div>
        </div>

        <div className="settings-sidebar-scroll">
          {q ? (
            <div className="settings-sidebar-group">
              <div className="settings-sidebar-group-title">
                {searchResults.length} {searchResults.length === 1 ? "Result" : "Results"}
              </div>
              {searchResults.map((item) => {
                const Icon = item.icon;
                const isCurrent = item.id === activePanel;
                const badge = item.badge?.(state);
                const badgeVariant = item.badgeVariant?.(state);
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={isCurrent ? "page" : undefined}
                    className={`settings-nav-button${isCurrent ? " active" : ""}`}
                    onClick={() => selectItem(item.id)}
                  >
                    <span className="settings-nav-button-icon">
                      <Icon size={15} />
                    </span>
                    <span className="settings-nav-button-label">{item.title}</span>
                    {badge && (
                      <span className={`settings-nav-item-badge${badgeVariant ? ` ${badgeVariant}` : ""}`}>
                        {badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            SETTINGS_CATEGORIES.map((category) => (
              <div key={category.title} className="settings-sidebar-group">
                <div className="settings-sidebar-group-title">{category.title}</div>
                {category.items.map((item) => {
                  const Icon = item.icon;
                  const isCurrent = item.id === activePanel;
                  const badge = item.badge?.(state);
                  const badgeVariant = item.badgeVariant?.(state);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-current={isCurrent ? "page" : undefined}
                    className={`settings-nav-button${isCurrent ? " active" : ""}`}
                      onClick={() => selectItem(item.id)}
                    >
                      <span className="settings-nav-button-icon">
                        <Icon size={15} />
                      </span>
                      <span className="settings-nav-button-label">{item.title}</span>
                      {badge && (
                        <span className={`settings-nav-item-badge${badgeVariant ? ` ${badgeVariant}` : ""}`}>
                          {badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="settings-sidebar-footer">
          <SegmentedControl
            ariaLabel="Appearance theme"
            value={appearance}
            onChange={(value) => setAppearance(value as Appearance)}
            options={[
              { value: "system", label: "Auto", icon: <Monitor size={13} /> },
              { value: "light", label: "Light", icon: <Sun size={13} /> },
              { value: "dark", label: "Dark", icon: <Moon size={13} /> },
            ]}
          />
        </div>
      </aside>

      <section className="settings-page-content">
        <header className="settings-page-header">
          <button className="settings-mobile-back" onClick={() => setMobileMode("menu")}><ChevronLeft size={18} /> Workspace</button>
          <h2 className="settings-page-title">{activeItem.title}</h2>
          <p className="settings-page-desc">{activeItem.description}</p>
        </header>
        <div className="settings-page-body">
          <Suspense fallback={<p className="quiet-copy" role="status">Opening {activeItem.title.toLowerCase()}…</p>}>
            <CapabilityPanelHost
              key={activePanel}
              onCreate={onCreate}
              onEditBot={(id) => onOpenCapability("bot", id)}
              panel={activePanel}
              state={state}
              threadId={thread}
              onOpen={(panel) => selectItem(panel)}
              onThread={(id) => {
                onOpenCapability(null, id);
                onThread(id);
              }}
              onChange={onRefresh}
            />
          </Suspense>
        </div>
      </section>
    </div>
  );
}

export function Studio() {
  const { appearance, setAppearance } = useAppearance();
  const [page, setPage] = useState<Page>(() => {
    const p = new URLSearchParams(window.location.search).get("panel");
    if (p === "settings" || isCapabilityPanel(p)) return "settings";
    return "chat";
  }),
    [thread, setThread] = useState(() => new URLSearchParams(window.location.search).get("thread")?.slice(0, 128) || "");
  const [state, setState] = useState<AppState | null>(null),
    [connections, setConnections] = useState<ConnectorStatus | null>(null),
    [skills, setSkills] = useState<CommunitySkill[]>([]);
  const [error, setError] = useState(""),
    [draftNotice, setDraftNotice] = useState(""),
    [online, setOnline] = useState(false),
    [refresh, setRefresh] = useState(0);
  const providerStatus = useProviderStatus(refresh);
  useEffect(() => {
    setAvatars(Object.fromEntries((state?.bots || []).filter((bot) => bot.avatarVersion).map((bot) => [bot.name, `/api/bots/${encodeURIComponent(bot.id)}/avatar?v=${bot.avatarVersion}`])));
  }, [state?.bots]);
  // The reply as it is written, per run, pushed by the studio event stream.
  const [liveTexts, setLiveTexts] = useState<Record<string, string>>({});
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  const sendError = sendErrors[thread] || "";
  const setSendError = (message: string) => setSendErrors((items) => ({ ...items, [thread]: message }));
  const firstLoad = useRef(true);
  const [documentFile, setDocumentFile] = useState<Attachment | null>(null);
  useEffect(() => setDocumentFile(null), [thread]);
  const [detail, setDetail] = useState<Detail | null>(() => new URLSearchParams(location.search).get("panel") === "settings" ? {kind: "settings"} : null),
    [recipient, setRecipient] = useState(""),
    [sending, setSending] = useState(false);
  const [capability, setCapability] = useState<CapabilityPanel | null>(() => {
    const value = new URLSearchParams(location.search).get("panel");
    return isCapabilityPanel(value) ? value : null;
  });
  function openCapability(next: CapabilityPanel | null, targetThread?: string) {
    setDetail(null);
    if (next) {
      setPage("settings");
      setCapability(next);
    } else {
      setCapability(null);
    }
    if (targetThread) setThread(targetThread);
    const url = new URL(location.href); url.pathname = "/";
    if (next) url.searchParams.set("panel", next); else url.searchParams.delete("panel");
    if (targetThread) url.searchParams.set("thread", targetThread);
    history.pushState(null, "", url);
  }
  function openSettings() {
    setDetail(null);
    setCapability(null);
    setPage("settings");
    const url = new URL(location.href);
    url.searchParams.set("panel", "settings");
    history.pushState(null, "", url);
  }
  useEffect(() => {
    const follow = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      // An explicit target (e.g. the provider setup link in the creation
      // sheet, "opens separately so you won't lose this draft") wins over
      // in-page capability routing.
      if (anchor.target && anchor.target !== "_self") return;
      const url = new URL(anchor.href, location.href), panel = url.searchParams.get("panel");
      if (url.origin !== location.origin || !["/", "/studio.html"].includes(url.pathname) || !isCapabilityPanel(panel)) return;
      event.preventDefault(); openCapability(panel, url.searchParams.get("thread") || undefined);
    };
    const restore = () => {
      const url = new URL(location.href), panel = url.searchParams.get("panel");
      if (panel === "settings" || isCapabilityPanel(panel)) {
        setPage("settings");
        setCapability(isCapabilityPanel(panel) ? panel : null);
      } else if (page === "settings" && !panel) {
        setPage("chat");
        setCapability(null);
      } else {
        setCapability(isCapabilityPanel(panel) ? panel : null);
      } setDetail(panel === "settings" ? {kind: "settings"} : null);
      if (url.searchParams.get("thread")) setThread(url.searchParams.get("thread")!);
    };
    document.addEventListener("click", follow); window.addEventListener("popstate", restore);
    return () => { document.removeEventListener("click", follow); window.removeEventListener("popstate", restore); };
  }, []);
  const composerDraft = useConversationDraft(thread, state?.draft);
  const attached = useConversationAttachments(thread);
  // P01c: one submission key per unsent content. Retries reuse it so a lost
  // response replays instead of duplicating; anything new rotates it.
  // U02c: reply target for the composer. Cleared when the conversation
  // changes or the send lands; the host validates it still exists.
  const [replyTo, setReplyTo] = useState<{ id: string; senderName: string; body: string } | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  useEffect(() => { setReplyTo(null); }, [thread]);
  const sendKeys = useRef(createSubmissionKeys());
  const fileInput = useRef<HTMLInputElement>(null);
  const draft = composerDraft.body,
    setDraft = composerDraft.setBody;
  const [dictating, setDictating] = useState(false);
  const showsMic = dictating || (!draft.trim() && !attached.files.length && !sending && dictationSupported());
  const pickStarter = (text: string) => {
    setDraft(text);
    window.setTimeout(() => { const box = document.getElementById("studio-message") as HTMLTextAreaElement | null; box?.focus(); box?.setSelectionRange(box.value.length, box.value.length); }, 0);
  };
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null),
    [mentionAt, setMentionAt] = useState(0);
  const mentionChoices = useMemo(() => {
    const current = state?.threads.find((item) => item.id === thread) || null;
    if (!current || current.kind !== "room") return [];
    const members = current.botIds
      ? (state?.bots || []).filter((bot) => current.botIds?.includes(bot.id))
      : state?.bots || [];
    return [
      ...members.map((bot) => ({ key: bot.id, insert: bot.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label: bot.name, detail: bot.role, face: <Face bot={bot} size={22} /> })),
      { key: "everyone", insert: "everyone", label: "everyone", detail: "The whole team", face: <MessageCircle size={16} /> },
    ];
  }, [state, thread]);
  const visibleMentions = mention
    ? mentionChoices.filter((choice) => choice.insert.includes(mention.query.toLowerCase()))
    : [];
  const readMention = (value: string, caret: number) => {
    const match = value.slice(0, caret).match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
    return match ? { start: caret - match[1]!.length - 1, query: match[1]! } : null;
  };
  const applyMention = (insert: string) => {
    const textarea = input.current;
    if (!textarea || !mention) return;
    const caret = textarea.selectionStart;
    const before = draft.slice(0, mention.start);
    const next = `${before}@${insert} ${draft.slice(caret).replace(/^\s+/, "")}`;
    setDraft(next);
    setMention(null);
    requestAnimationFrame(() => {
      const position = before.length + insert.length + 2;
      textarea.focus();
      textarea.setSelectionRange(position, position);
    });
  };
  const [libraryTab, setLibraryTab] = useState<"apps" | "skills">("apps"),
    [query, setQuery] = useState("");
  const [conversationQuery, setConversationQuery] = useState("");
  const [needsYouOnly, setNeedsYouOnly] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [takeoverBot, setTakeoverBot] = useState<Bot | null>(null);
  const [signInPane, setSignInPane] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1050);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("sidemates:sidebar-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = () => {
    setSidebarCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem("sidemates:sidebar-collapsed", next ? "1" : "0");
      } catch {
        /* Private mode: collapse still works for this visit. */
      }
      return next;
    });
  };
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1049px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b" && !event.shiftKey && !event.altKey) {
        const target = event.target;
        if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Split view: when a teammate waits on a private sign-in in this
  // conversation, open the live website beside the chat, the way a second
  // column of work belongs next to the conversation. Narrow screens get the
  // same handoff as a returnable fullscreen overlay instead of a dead end.
  // It closes itself once the handoff is decided, and the task card reopens
  // it on request.
  const pendingSignInId = useMemo(() => {
    if (!state) return null;
    return selectPendingSignIn(state.approvals, state.runs, thread);
  }, [state, thread]);
  useEffect(() => { setSignInPane(pendingSignInId); }, [pendingSignInId]);
  const [calendarDate, setCalendarDate] = useState(dayKey(new Date()));
  const [month, setMonth] = useState(dayKey(new Date()).slice(0, 7) + "-01");
  const input = useRef<HTMLTextAreaElement>(null),
    messagesEnd = useRef<HTMLDivElement>(null),
    messageScroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true),
    requestNumber = useRef(0);
  // Composer auto-grow: keep the one-line start, grow to 240px, then scroll.
  useEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 240)}px`;
  }, [draft, thread, page]);
  useEffect(() => {
    if (!thread) return;
    const url = new URL(window.location.href); url.searchParams.set("thread", thread);
    window.history.replaceState(null, "", url);
  }, [thread]);
  useEffect(() => {
    const abort = new AbortController(),
      current = ++requestNumber.current;
    void api<AppState>(
      `/api/state?threadId=${encodeURIComponent(thread)}`,
      undefined,
      abort.signal,
    )
      .then((result) => {
        if (abort.signal.aborted || current !== requestNumber.current) return;
        setState(result);
        if (firstLoad.current) {
          firstLoad.current = false;
          setRecipient(result.bots.find((bot) => bot.threadId === result.activeThreadId)?.id || "");
        }
        if (result.activeThreadId !== thread) setThread(result.activeThreadId);
        setError("");
        setOnline(true);
      })
      .catch((reason: Error) => {
        if (!abort.signal.aborted) {
          setError(reason.message);
          setOnline(false);
        }
      });
    return () => abort.abort();
  }, [thread, refresh]);
  useEffect(() => {
    const events = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRefresh((n) => n + 1), 250);
    };
    events.onmessage = (message) => {
      // Live reply text is applied directly; it never refetches the studio.
      try {
        const event = JSON.parse(message.data) as { type?: string; runId?: string; text?: string };
        if (event.type === "live" && event.runId && typeof event.text === "string") {
          setLiveTexts((current) => ({ ...current, [event.runId!]: event.text! }));
          return;
        }
      } catch { /* A plain state ping. */ }
      update();
    };
    events.onopen = () => {
      setOnline(true);
      update();
    };
    events.onerror = () => setOnline(false);
    const fallback = setInterval(update, 15_000);
    window.addEventListener("focus", update);
    return () => {
      events.close();
      clearTimeout(timer);
      clearInterval(fallback);
      window.removeEventListener("focus", update);
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    if (page === "library") {
      void Promise.all([
        api<ConnectorStatus>("/api/connectors", undefined, abort.signal),
        api<{ skills: CommunitySkill[] }>(
          "/api/extensions",
          undefined,
          abort.signal,
        ),
      ])
        .then(([apps, extensions]) => {
          if (!abort.signal.aborted) {
            setConnections(apps);
            setSkills(extensions.skills);
          }
        })
        .catch((reason: Error) => {
          if (!abort.signal.aborted) setError(reason.message);
        });
    }
    return () => abort.abort();
  }, [page, refresh]);
  useEffect(() => {
    if (page === "chat" && nearBottom.current)
      messagesEnd.current?.scrollIntoView({ block: "end" });
  }, [state?.messages, state?.runs, page, liveTexts]);
  useEffect(() => {
    setDetail((current) => {
      if (current?.kind !== "run" || !state) return current;
      const fresh = [...state.studioRuns, ...state.runs].find(
        (run) => run.id === current.run.id,
      );
      return fresh ? { kind: "run", run: fresh } : current;
    });
  }, [state]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDetail({ kind: "search" });
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const openThread = (id: string) => {
    setThread(id);
    setPage("chat");
    setDetail(null);
    setCapability(null);
    nearBottom.current = true;
    const bot = state?.bots.find((item) => item.threadId === id);
    setRecipient(bot?.id || "");
    const url = new URL(window.location.href);
    if (url.searchParams.has("panel")) {
      url.searchParams.delete("panel");
      window.history.pushState(null, "", url);
    }
  };
  const navigate = (next: Page) => {
    setPage(next);
    setQuery("");
    setDetail(null);
    setCapability(null);
    const url = new URL(window.location.href);
    if (url.searchParams.has("panel")) {
      url.searchParams.delete("panel");
      window.history.pushState(null, "", url);
    }
  };
  // The front door: when something is waiting, open there once, unless a conversation or panel was asked for.
  // Read what was asked for at load time: the app itself adds ?thread= to the address later.
  const asked = useRef(new URLSearchParams(window.location.search));
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !state) return;
    landed.current = true;
    // ?waiting=1 is what a "things are waiting for you" notification opens.
    if (asked.current.get("waiting") !== null && page === "chat") navigate("waiting");
    else if ((state.queueReady ?? 0) > 0 && !asked.current.get("thread") && !asked.current.get("panel") && page === "chat") navigate("waiting");
  }, [state]);
  const startPrompt = (text: string) => {
    setPage("chat");
    if (draft.trim())
      setDraftNotice(
        "Your draft is still here. Send it or clear it before starting something new.",
      );
    else {
      setDraft(text);
      setDraftNotice("");
    }
    setTimeout(() => input.current?.focus(), 0);
  };
  const botReady = Boolean(
    state?.bots.some(
      (bot) =>
        (!recipient || bot.id === recipient) &&
        bot.providerInstanceId &&
        bot.model,
    ),
  );
  const budgetBot = state?.bots.find(bot => bot.id === (recipient || state.threads.find(item => item.id === thread)?.botId));
  const budgetReached = budgetBot && budgetBot.weeklyTokenBudget > 0 && budgetBot.tokensUsedThisWeek >= budgetBot.weeklyTokenBudget;
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (
      (!draft.trim() && !attached.files.length) ||
      sending ||
      attached.uploading ||
      !attached.ready ||
      !composerDraft.ready ||
      !state ||
      state.activeThreadId !== thread ||
      !online
    )
      return;
    // No AI chosen yet: sending would only fail on the host. Open the
    // chooser right away; the draft stays typed and ready.
    if (!botReady) {
      setSendError("");
      openCapability("provider");
      return;
    }
    const body = draft.trim(),
      targetThread =
        page === "chat"
          ? thread
          : recipient
            ? state.bots.find((bot) => bot.id === recipient)!.threadId
            : "team-room";
    setSending(true);
    setSendError("");
    const sentDraft = composerDraft.capture();
    const sentFiles = attached.files.map((file) => file.id);
    const sendScope = {
      threadId: targetThread,
      body,
      targetBotIds: recipient ? [recipient] : [],
      attachmentIds: sentFiles,
      replyToId: replyTo?.id ?? null,
    };
    try {
      await api("/api/messages", {
        threadId: targetThread,
        body,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        targetBotIds: recipient ? [recipient] : [],
        attachmentIds: sentFiles,
        replyToId: replyTo?.id ?? null,
        requestId: sendKeys.current.keyFor(sendScope),
      });
      // Delivered or replayed: the next deliberate send is new work.
      sendKeys.current.rotate();
      setReplyTo(null);
      composerDraft.clearSent(sentDraft);
      attached.clear(targetThread, sentFiles);
      setRefresh((n) => n + 1);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "request_conflict") {
        // Same key, changed payload: the host changed nothing. Rotate so the
        // next press sends fresh, and keep the exact unsent content.
        sendKeys.current.rotate();
        setSendError(
          "That retry didn’t match your original send, so nothing was duplicated. Review your message and send again — your draft is untouched.",
        );
      } else {
        setSendError(
          reason instanceof Error
            ? reason.message
            : "Your message wasn’t sent. It’s still here to try again.",
        );
      }
    } finally {
      setSending(false);
    }
  };
  // "Try again" on the latest finished reply: the same request, same
  // teammate, through the normal send path (budgets, approvals, replay keys).
  const retryTarget = useMemo(() => {
    const talk = (state?.messages || []).filter((message) => message.kind === "text");
    const reply = talk.at(-1);
    if (!reply || reply.senderType !== "bot" || !reply.runId) return null;
    const run = state?.runs.find((item) => item.id === reply.runId);
    if (!run || run.parentRunId || !["completed", "failed", "cancelled"].includes(run.status)) return null;
    const trigger = talk.find((message) => message.id === run.triggerMessageId) || [...talk].reverse().find((message) => message.senderType === "user");
    if (!trigger || trigger.attachments.length) return null;
    return { replyId: reply.id, body: trigger.body, botId: run.botId };
  }, [state?.messages, state?.runs]);
  // The honesty line sits once, under the latest teammate answer.
  const lastTeamReplyId = useMemo(() => {
    return [...(state?.messages || [])].reverse().find((message) => message.kind === "text" && message.senderType === "bot")?.id || null;
  }, [state?.messages]);
  const lastOwnMessageId = useMemo(() => {
    return [...(state?.messages || [])].reverse().find((message) => message.kind === "text" && message.senderType === "user")?.id || null;
  }, [state?.messages]);
  const retryReply = async () => {
    if (!retryTarget || sending || !state) return;
    setSending(true); setSendError("");
    try {
      await api("/api/messages", { threadId: thread, body: retryTarget.body, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, targetBotIds: [retryTarget.botId], requestId: `retry-${retryTarget.replyId}-${Date.now()}` });
      setRefresh((n) => n + 1);
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : "Couldn't ask again. Try once more.");
    } finally { setSending(false); }
  };
  const active =
    state?.studioRuns.filter(
      (run) => !run.parentRunId && activeStates.includes(run.status),
    ) || [];
  const conversationFiles = useMemo(() => state?.messages.flatMap((message) => message.attachments) || [], [state?.messages]);
  const attention = tasksNeedingOwner(state?.studioRuns || []);
  const uncertain =
    state?.approvedActions.filter((action) => action.status === "uncertain") ||
    [];
  // Autopilot: in a chat with one teammate it is that teammate's switch; anywhere else it is the studio-wide one.
  const everyoneOnAutopilot = state?.settings.yoloMode === true;
  const autopilotBot = page === "chat" ? state?.bots.find((bot) => bot.threadId === thread) : undefined;
  const yoloMode = everyoneOnAutopilot || autopilotBot?.autopilot === true;
  const [modeBusy, setModeBusy] = useState(false);
  async function toggleMode() {
    if (modeBusy) return;
    const next = !yoloMode;
    const forTeammate = !everyoneOnAutopilot && autopilotBot ? autopilotBot : null;
    if (next && !window.confirm(`${forTeammate ? `Turn on Autopilot for ${forTeammate.name}?` : "Turn on Autopilot for every teammate?"}\n\n${AUTOPILOT_WARNING}`)) return;
    setModeBusy(true);
    try {
      const response = forTeammate
        ? await fetch(`/api/bots/${encodeURIComponent(forTeammate.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autopilot: next }) })
        : await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ yoloMode: next }) });
      if (!response.ok) throw new Error("The mode could not be changed.");
      setRefresh((value) => value + 1);
    } catch {
      setError("Autopilot could not be changed. Try again.");
    } finally {
      setModeBusy(false);
    }
  }
  const alerts =
    state?.automationAlerts.filter((alert) => !alert.resolvedAt) || [];
  const otherApprovals =
    state?.approvals.filter(
      (approval) => !attention.some((run) => run.id === approval.runId),
    ) || [];
  const attentionCount =
    attention.length + uncertain.length + alerts.length + otherApprovals.length;
  const finished =
    state?.studioRuns.filter(
      (run) => !run.parentRunId && run.status === "completed",
    ) || [];
  const upcoming =
    state?.routines
      .filter((routine) => routine.enabled && routine.nextRunAt)
      .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!)) || [];
  const threadTitle =
    state?.threads.find((item) => item.id === thread)?.title || "Conversation";
  const agentsToBringOver = useAgentsToBringOver();
  // Set once the first team is created, so Waiting for you starts the first look by itself.
  const [firstLook, setFirstLook] = useState(false);
  const actionGroups = groupConsecutiveActionEvents(state?.messages || []);
  const actionGroupByFirstId = new Map(actionGroups.map((group) => [group[0]!.id, group]));
  const actionGroupMemberIds = new Set(actionGroups.flatMap((group) => group.slice(1).map((message) => message.id)));
  const routineGroups = groupConsecutiveRoutineRuns(state?.messages || []);
  const routineGroupByFirstId = new Map(routineGroups.map((group) => [group[0]!.id, group]));
  const routineGroupMemberIds = new Set(routineGroups.flatMap((group) => group.slice(1).map((message) => message.id)));
  // Fold consecutive talking pills between the same pair — Apple groups
  // repeated system lines instead of stacking five identical pills.
  const talkFold = useMemo(
    () => foldTalkingPills(state?.messages || []),
    [state?.messages],
  );
  const [voiceOpen, setVoiceOpen] = useState(false);
  const conversationBot =
    page === "chat"
      ? state?.bots.find((bot) => bot.threadId === thread)
      : undefined;
  const conversationThread = page === "chat" ? state?.threads.find((item) => item.id === thread) : undefined;
  // What the teammates here are for, so the starters fit their jobs.
  const conversationJobs = conversationBot ? [conversationBot.role] : (conversationThread?.botIds || []).map((id) => state?.bots.find((bot) => bot.id === id)?.role || "");
  const title =
    page === "chat"
      ? threadTitle
      : {
          home: "Chats",
          waiting: "Waiting for you",
          activity: "Activity",
          schedule: "Schedule",
          library: "Library",
          settings: "Settings",
        }[page];
  const navItems = [
    ["home", "Chats", MessageCircle],
    ["activity", "Activity", Layers3],
    ["schedule", "Schedule", CalendarDays],
    ["library", "Library", FileText],
  ] as const;

  const composer = (
    <form
      className={`composer ${page === "chat" ? "composer-chat" : ""}`}
      onSubmit={send}
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer?.files || []);
        if (!files.length) return;
        event.preventDefault();
        void attached.add(files);
      }}
    >
      {page === "chat" && conversationBot && (
        <div className="composer-model">
          <ModelPicker
            bot={conversationBot}
            provider={providerStatus}
            direction="up"
            save={async (patch) => {
              const response = await fetch(`/api/bots/${encodeURIComponent(conversationBot.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
              if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || "That AI choice could not be saved.");
              setRefresh((n) => n + 1);
            }}
          />
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        aria-label="Choose files"
        onChange={(event) => {
          void attached.add(Array.from(event.target.files || []));
          event.target.value = "";
        }}
      />
      {attached.files.length > 0 && (
        <div className="compose-files">
          {attached.files.map((file) => {
            const size = `${Math.max(1, Math.ceil(file.size / 1000))} KB`;
            return (
              <span key={file.id} className="compose-file">
                {file.kind === "image" && file.previewUrl ? (
                  <img src={file.previewUrl} alt="" className="compose-thumb" />
                ) : (
                  <span className={fileSiglaClass(file)} aria-hidden="true">{fileLabel(file)}</span>
                )}
                <span className="compose-file-meta">
                  <strong>{file.name}</strong>
                  <small>{size} · {file.kind}</small>
                </span>
                <button
                  type="button"
                  className="compose-file-remove"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => attached.remove(file.id)}
                >
                  <X size={13} />
                </button>
              </span>
            );
          })}
        </div>
      )}
      <label className="sr-only" htmlFor="studio-message">
        Message your team
      </label>
      {replyTo && (
        <div className="compose-reply" role="status">
          <span className="compose-reply-preview">
            Replying to {replyTo.senderName}: {replyTo.body.replace(/\s+/g, " ").trim().slice(0, 120)}
          </span>
          <button type="button" className="compose-reply-cancel" aria-label="Cancel reply" onClick={() => setReplyTo(null)}>
            <X size={13} />
          </button>
        </div>
      )}
      <textarea
        ref={input}
        id="studio-message"
        value={draft}
        disabled={!composerDraft.ready}
        aria-busy={!composerDraft.ready}
        onChange={(event) => {
          setDraft(event.target.value);
          setDraftNotice("");
          const info = readMention(event.target.value, event.target.selectionStart);
          setMention(info);
          setMentionAt(0);
        }}
        onSelect={(event) => {
          const info = readMention(event.currentTarget.value, event.currentTarget.selectionStart ?? 0);
          setMention(info);
        }}
        placeholder={
          !composerDraft.ready
            ? "Restoring your draft…"
            : conversationBot
            ? `What’s next, ${conversationBot.name}?`
            : page === "chat"
              ? "Message your team…"
              : "Ask anything. Make a plan. Get something done."
        }
        rows={1}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData?.files || []);
          if (!files.length) return;
          event.preventDefault();
          void attached.add(files);
        }}
        onKeyDown={(event) => {
          // Cmd/Ctrl+Enter always sends, even with the mention menu open.
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
            return;
          }
          if (mention && visibleMentions.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setMentionAt((index) => (index + 1) % visibleMentions.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setMentionAt((index) => (index - 1 + visibleMentions.length) % visibleMentions.length);
              return;
            }
            if (event.key === "Escape") {
              setMention(null);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              applyMention(visibleMentions[mentionAt % visibleMentions.length]!.insert);
              return;
            }
          }
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      {mention && visibleMentions.length > 0 && (
        <div className="composer-mention" role="listbox" aria-label="Mention a teammate">
          {visibleMentions.map((choice, index) => (
            <button
              type="button"
              key={choice.key}
              role="option"
              aria-selected={index === mentionAt % visibleMentions.length}
              className={index === mentionAt % visibleMentions.length ? "current" : ""}
              onMouseDown={(event) => { event.preventDefault(); applyMention(choice.insert); }}
              onMouseEnter={() => setMentionAt(index)}
            >
              {choice.face}
              <span><strong>{choice.label}</strong><small>{choice.detail}</small></span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-bar">
        <details className="composer-options" onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary aria-label="Message options"><Plus size={18} /></summary><div className="composer-options-content">
        <button
          type="button"
          className={`composer-mode ${yoloMode ? "yolo" : ""}`}
          onClick={() => void toggleMode()}
          disabled={modeBusy}
          aria-pressed={yoloMode}
          title={yoloMode ? "Autopilot: acts without asking first. Switch back to asking first." : "Ask first: work can start, but sensitive actions wait for your approval. Switch on Autopilot to let it act like a person."}
          aria-label={yoloMode ? "Autopilot is on. Switch to ask first." : "Ask first is on. Switch to Autopilot."}
        >
          <ShieldQuestion size={15} />
          {yoloMode ? "Autopilot" : "Ask first"}
        </button>
        <button
          type="button"
          className="add-file"
          aria-label="Add files"
          disabled={!attached.ready || attached.uploading || sending}
          onClick={() => fileInput.current?.click()}
        >
          {attached.uploading ? (
            <LoaderCircle size={18} className="spin" />
          ) : (
            <Plus size={20} />
          )}
        </button>
        <ChoiceMenu
            compact
            label="Choose a teammate"
            value={recipient}
            choices={[{ value: "", label: "Your team", detail: "Let the team choose who can help", icon: <MessageCircle size={20}/> }, ...(state?.bots || []).map((bot) => ({ value: bot.id, label: bot.name, detail: bot.role, icon: <Face bot={bot} size={30}/> }))]}
            onChange={(selected) => {
              setRecipient(selected);
              if (page === "chat" && thread !== "team-room") {
                setThread(
                  state?.bots.find((bot) => bot.id === selected)?.threadId ||
                    "team-room",
                );
                nearBottom.current = true;
              }
            }}
          />
        </div></details>
        <span className="composer-hint">
          {sending ? "Sending…" : !composerDraft.ready ? "Restoring draft…" : "Enter to send · ⌘↵ too"}
        </span>
        {/* One action slot, as in Messages: the microphone while the box is
            empty (or while dictating), Send once there is something to send. */}
        <span className={`composer-action ${showsMic ? "shows-mic" : "shows-send"}`}>
        <DictationButton draft={draft} setDraft={setDraft} disabled={!composerDraft.ready || sending} onListening={setDictating} concealed={!showsMic} />
        <button
          className="send"
          tabIndex={showsMic ? -1 : undefined}
          aria-hidden={showsMic || undefined}
          aria-label="Send message"
          disabled={
            (!draft.trim() && !attached.files.length) ||
            sending ||
            attached.uploading ||
            !attached.ready ||
            !composerDraft.ready ||
            state?.activeThreadId !== thread ||
            !online
          }
        >
          {sending ? (
            <LoaderCircle size={19} className="spin" />
          ) : (
            <ArrowUp size={20} />
          )}
        </button>
        </span>
      </div>
      {!botReady && state && (
        <a className="provider-needed" href="/?panel=provider">
          Choose your AI connection to send a message <ArrowRight size={13} />
        </a>
      )}
      {budgetReached && !sendError && (
        <p className="send-error" role="status">
          {budgetBot.name} has reached the weekly budget configured in Sidemates. Your provider’s allowance is separate.{" "}
          <button type="button" onClick={() => openCapability("bot", budgetBot.threadId)}>Review budget</button>
        </p>
      )}
      {sendError && (
        <p className="send-error" role="alert">
          {sendError} Your draft has been kept.
          {budgetReached && <button type="button" onClick={() => openCapability("bot", budgetBot.threadId)}>Review budget</button>}
        </p>
      )}
      {attached.error && (
        <p className="send-error" role="alert">
          {attached.error}
          <button type="button" onClick={attached.retry}>Try again</button>
        </p>
      )}
      {composerDraft.error && (
        <p className="send-error" role="alert">
          {composerDraft.error}{" "}
          <button type="button" onClick={() => composerDraft.saveNow()}>
            Retry saving
          </button>
        </p>
      )}
      {composerDraft.conflict && (
        <div className="draft-conflict" role="status">
          <p>This conversation has a different draft on another device.</p>
          <blockquote>
            {composerDraft.conflict.body || "(Empty draft)"}
          </blockquote>
          <button type="button" onClick={composerDraft.keepLocal}>
            Keep this draft
          </button>
          <button type="button" onClick={composerDraft.useRemote}>
            Use other draft
          </button>
        </div>
      )}
      {draftNotice && (
        <p className="draft-notice" role="status">
          {draftNotice}
        </p>
      )}
    </form>
  );
  const runRow = (run: Run) => (
    <button
      className="work-row"
      key={run.id}
      onClick={() => setDetail({ kind: "run", run })}
    >
      <span className="work-document">
        {activeStates.includes(run.status) ? (
          <Character
            name={run.botName}
            color={run.botColor}
            variant={run.botMascot}
            status="working"
            size={39}
          />
        ) : (
          <FileText size={20} strokeWidth={1.3} />
        )}
      </span>
      <span>
        <strong>{run.task.goal}</strong>
        <small>
          {run.botName} <span>·</span> {labelFor(run.status)}
        </small>
      </span>
      <span className="work-meta">
        {run.finishedAt || run.startedAt
          ? dateText((run.finishedAt || run.startedAt)!)
          : ""}
        <ChevronRight size={15} />
      </span>
    </button>
  );
  const scheduleRow = (routine: Routine) => (
    <button
      className="agenda-row"
      key={routine.id}
      onClick={() => openThread(routine.threadId)}
    >
      <time>{timeText(routine.nextRunAt!)}</time>
      <span>
        <strong>{routine.name}</strong>
        <small>
          {routine.botName} · {dateText(routine.nextRunAt!)}
        </small>
      </span>
      <ChevronRight size={14} />
    </button>
  );
  const activeNow = activeNowBots(state?.bots || []);
  // Display lookups span active + retired teammates: a retired mascot is
  // still the right face for old groups and event pills.
  const allBots = state ? [...state.bots, ...(state.retiredBots || [])] : [];
  const headerMembers =
    page === "chat" && conversationThread
      ? (conversationThread.botIds || [])
          .map((id) => allBots.find((bot) => bot.id === id))
          .filter((member): member is Bot => Boolean(member))
          .slice(0, 2)
      : [];
  const [threadActionError, setThreadActionError] = useState("");
  const [pendingThreads, setPendingThreads] = useState<string[]>([]);
  const threadChanges = useRef(new Set<string>());
  async function changeThread(item: { id: string; title: string }, patch: { pinned?: boolean; hidden?: boolean }) {
    if (threadChanges.current.has(item.id)) return false;
    threadChanges.current.add(item.id);
    setPendingThreads([...threadChanges.current]);
    setThreadActionError("");
    try {
      const response = await fetch(`/api/threads/${encodeURIComponent(item.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The host could not save this conversation change.");
      setState(current => current ? { ...current, threads: current.threads.map(thread => thread.id === item.id ? { ...thread, ...result } : thread) } : current);
      setRefresh(n => n + 1);
      return true;
    } catch (error) {
      setThreadActionError(`Couldn’t update ${item.title}. ${error instanceof Error ? error.message : "Check your connection and try again."}`);
      setRefresh(n => n + 1);
      return false;
    } finally {
      threadChanges.current.delete(item.id);
      setPendingThreads([...threadChanges.current]);
    }
  }
  const setPin = (item: Thread, pinned: boolean) => void changeThread(item, { pinned });
  // Row quick actions: hover reveals on desktop, swipe reveals on touch.
  // Archiving is a two-tap reversible hide: the server keeps everything and
  // the Archived section below can bring the chat back. There is no hard
  // conversation delete in this client; nothing here may promise one.
  const [swipedRow, setSwipedRow] = useState<string | null>(null);
  const [archiveArmed, setArchiveArmed] = useState<string | null>(null);
  const dragStartX = useRef<number | null>(null);
  const dragStartY = useRef<number | null>(null);
  // When the last drag released, as a timestamp. A trailing click right
  // after a drag belongs to the gesture and is ignored; a sticky boolean
  // would stay set forever when pointer capture retargets that click away
  // from the row button, silently eating a later, deliberate tap.
  const lastRowDrag = useRef<{ id: string; at: number } | null>(null);
  const dragEngaged = useRef(false);
  const dragBase = useRef(0);
  const dragX = useRef(0);
  // Recent pointer positions for release-velocity: a flick's sign decides
  // open vs. close, distance is only the fallback.
  const gestureHist = useRef<Array<{ x: number; t: number }>>([]);
  function trackGesture(x: number) {
    const hist = gestureHist.current;
    hist.push({ x, t: performance.now() });
    if (hist.length > 8) hist.splice(0, hist.length - 8);
  }
  function releaseVelocity(): number {
    const hist = gestureHist.current;
    if (hist.length < 2) return 0;
    const first = hist[0]!;
    const last = hist[hist.length - 1]!;
    const dt = last.t - first.t;
    if (dt <= 0) return 0;
    return (last.x - first.x) / dt; // px per ms; <0 flicked left, >0 right
  }
  // A spring settling on another row: commit it instantly so a new grab
  // never leaves two rows mid-flight.
  const flight = useRef<{
    itemId: string;
    spring: ReturnType<typeof createSpring>;
    row: HTMLElement;
    actions: HTMLElement | null;
    target: number;
  } | null>(null);
  function clearRowInline(row: HTMLElement, actions: HTMLElement | null) {
    row.style.transition = "";
    row.style.transform = "";
    if (actions) actions.style.opacity = "";
  }
  function finishFlight(commit: boolean) {
    const f = flight.current;
    flight.current = null;
    if (!f) return;
    f.spring.stop();
    if (commit) {
      const open = f.target < 0;
      flushSync(() => {
        setSwipedRow(open ? f.itemId : null);
      });
    }
    f.row.closest(".conversation-cell")?.classList.remove("dragging");
    clearRowInline(f.row, f.actions);
  }
  const archiveTimer = useRef<number | null>(null);
  async function archiveThread(item: Thread) {
    if (archiveArmed !== item.id) {
      setArchiveArmed(item.id);
      if (archiveTimer.current) window.clearTimeout(archiveTimer.current);
      archiveTimer.current = window.setTimeout(() => setArchiveArmed(null), 2600);
      return;
    }
    if (archiveTimer.current) window.clearTimeout(archiveTimer.current);
    setArchiveArmed(null);
    setSwipedRow(null);
    try { navigator.vibrate?.(10); } catch { /* haptics unavailable */ }
    if (await changeThread(item, { hidden: true }) && thread === item.id) openThread("team-room");
  }
  async function unhideThread(item: Thread) {
    await changeThread(item, { hidden: false });
  }
  const pinnedThreads = (state?.threads || []).filter((item) => !item.hidden && item.pinned && (!needsYouOnly || item.needsYou) && conversationMatches(item, allBots, conversationQuery));
  const archivedThreads = (state?.threads || []).filter((item) => item.hidden);
  const isGroupThread = (item: Thread) =>
    (item.botIds?.length ?? 0) > 1 ||
    item.id.startsWith("group-") ||
    item.id === "team-room";
  const visibleThreads = (state?.threads || []).filter(
    (item) =>
      !item.hidden &&
      !item.pinned && (!needsYouOnly || item.needsYou) &&
      (item.id !== "team-room" || Boolean(item.lastMessage || item.needsYou)) &&
      conversationMatches(item, allBots, conversationQuery),
  );
  const filteredConversationCount = pinnedThreads.length + visibleThreads.length;
  const threadRow = (item: Thread) => {
      const bot = allBots.find((bot) => bot.threadId === item.id);
      const members = (item.botIds || [])
        .map((id) => allBots.find((bot) => bot.id === id))
        .filter((member): member is Bot => Boolean(member));
      const memberNames = members.map((member) => member.name).join(", ");
      // Group membership events ("The group X now has…", "A joined · B left")
      // read as noise in a list — real messaging apps show the members.
      const cleanLast = item.lastMessage?.replace(/[*#_`]/g, "") || "";
      const listSubtitle =
        !cleanLast || isMembershipText(cleanLast)
          ? memberNames || bot?.role || "A conversation with your team"
          : cleanLast;
      // Discord-style live presence: when this teammate — or a member of this
      // group — is working right now, the subtitle becomes a small animated
      // pill with their mascot. Done = back to the quiet last-message line.
      const liveBot =
        bot && (bot.status === "working" || bot.status === "celebrating")
          ? bot
          : members.find(
              (member) => member.status === "working" || member.status === "celebrating",
            );
      const liveAction = liveBot
        ? liveBot.currentAction || (liveBot.status === "celebrating" ? "Celebrating" : "")
        : "";
      // Group pills show who is talking plus one more face, so you see both
      // sides of the conversation at a glance.
      const liveFaces = liveBot
        ? [liveBot, ...members.filter((member) => member.id !== liveBot.id)].slice(0, members.length > 1 ? 2 : 1)
        : [];
      const canEditGroup = item.id.startsWith("group-");
      const editRow = canEditGroup
        ? () => setDetail({ kind: "group", threadId: item.id })
        : bot && !isGroupThread(item)
          ? () => openCapability("bot", bot.threadId)
          : undefined;
      const actionCount = (item.id !== "team-room" ? 1 : 0) + (editRow ? 1 : 0) + (item.id !== "team-room" ? 1 : 0);
      const shiftPx = actionCount * 48 + 4;
      const rowParts = (cell: HTMLElement) => ({
        row: cell.querySelector<HTMLElement>(".conversation-row"),
        actions: cell.querySelector<HTMLElement>(".row-actions"),
      });
      const endRowDrag = (cell: HTMLElement, cancelled: boolean) => {
        const startX = dragStartX.current;
        dragStartX.current = null;
        dragStartY.current = null;
        if (startX == null || !dragEngaged.current) return;
        dragEngaged.current = false;
        const { row, actions } = rowParts(cell);
        if (!row) return;
        const v = cancelled ? 0 : releaseVelocity();
        const x = dragX.current;
        // A flick decides by direction; a slow drag by resting position.
        const target =
          !cancelled && Math.abs(v) > 0.25
            ? v < 0
              ? -shiftPx
              : 0
            : x < -shiftPx / 2
              ? -shiftPx
              : 0;
        lastRowDrag.current = { id: item.id, at: performance.now() };
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          cell.classList.remove("dragging");
          setSwipedRow(target < 0 ? item.id : null);
          clearRowInline(row, actions);
          return;
        }
        let settled = false;
        const spring = createSpring(
          x,
          (value) => {
            row.style.transform = `translateX(${value}px)`;
            if (actions)
              actions.style.opacity = String(
                Math.min(1, Math.max(0, -value / shiftPx)),
              );
            if (!settled && value === target) {
              settled = true;
              const open = target < 0;
              flight.current = null;
              // Commit first so the CSS resting state already matches when
              // the inline transform comes off — no flash either way.
              flushSync(() => {
                setSwipedRow(open ? item.id : null);
              });
              cell.classList.remove("dragging");
              clearRowInline(row, actions);
            }
          },
          { response: 0.3, dampingRatio: 1 },
        );
        flight.current = { itemId: item.id, spring, row, actions, target };
        spring.start(target, Math.max(-4000, Math.min(4000, v * 1000)));
      };
      return (
        <div
          key={item.id}
          className={`conversation-cell${swipedRow === item.id ? " swiped" : ""}`}
          style={{ "--shift": `${shiftPx}px` } as CSSProperties}
          onPointerDown={(event) => {
            if (event.button > 0) return;
            if ((event.target as HTMLElement).closest(".row-actions, .row-action-toggle")) return;
            const cell = event.currentTarget;
            if (flight.current && flight.current.itemId !== item.id)
              finishFlight(true);
            else if (flight.current) {
              // Grabbed mid-settle: keep blending from the live position.
              flight.current.spring.stop();
              flight.current = null;
            }
            const { row } = rowParts(cell);
            const inline = row?.style.transform
              ? Number.parseFloat(row.style.transform.replace(/[^\d.-]/g, ""))
              : Number.NaN;
            dragBase.current =
              Number.isFinite(inline) && row?.style.transform
                ? inline
                : swipedRow === item.id
                  ? -shiftPx
                  : 0;
            dragX.current = dragBase.current;
            dragStartX.current = event.clientX;
            dragStartY.current = event.clientY;
            dragEngaged.current = false;
            gestureHist.current = [{ x: event.clientX, t: performance.now() }];
          }}
          onPointerMove={(event) => {
            // Hovering without a pressed button is never a drag — reset so a
            // later click can't inherit a stale gesture and get swallowed.
            if (event.buttons === 0) {
              dragStartX.current = null;
              dragStartY.current = null;
              dragEngaged.current = false;
              return;
            }
            const startX = dragStartX.current;
            const startY = dragStartY.current;
            if (startX == null || startY == null) return;
            const dx = event.clientX - startX;
            const dy = event.clientY - startY;
            if (!dragEngaged.current) {
              if (Math.abs(dx) < 10) return;
              // Vertical scrolling wins ties — let the list scroll instead.
              if (Math.abs(dy) > Math.abs(dx)) {
                dragStartX.current = null;
                dragStartY.current = null;
                return;
              }
              dragEngaged.current = true;
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                /* pointer already released */
              }
              event.currentTarget.classList.add("dragging");
            }
            trackGesture(event.clientX);
            const cell = event.currentTarget;
            const { row, actions } = rowParts(cell);
            if (!row) return;
            let x = dragBase.current + (event.clientX - startX);
            // Rubber-band past both edges instead of hard-stopping.
            if (x < -shiftPx) x = -shiftPx + rubberband(x + shiftPx, shiftPx);
            else if (x > 0) x = rubberband(x, shiftPx);
            dragX.current = x;
            row.style.transition = "none";
            row.style.transform = `translateX(${x}px)`;
            if (actions)
              actions.style.opacity = String(
                Math.min(1, Math.max(0, -x / shiftPx)),
              );
          }}
          onPointerUp={(event) => endRowDrag(event.currentTarget, false)}
          onPointerCancel={(event) => endRowDrag(event.currentTarget, true)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && swipedRow === item.id) setSwipedRow(null);
          }}
        >
        <button
          aria-label={item.title}
          title={item.title}
          className={`conversation-row ${page === "chat" && thread === item.id ? "current" : ""}${liveAction ? " is-live" : ""}`}
          onClick={() => {
            // A click landing right after a drag release belongs to the
            // gesture, not to a tap — ignore it, then forget it happened.
            if (lastRowDrag.current?.id === item.id && performance.now() - lastRowDrag.current.at < 350) return;
            if (swipedRow === item.id) { setSwipedRow(null); return; }
            openThread(item.id);
          }}
        >
          {members.length > 1 ? (
            <span className="group-stack" aria-hidden="true">
              <Face bot={members[0]!} size={30} />
              <Face bot={members[1]!} size={30} />
            </span>
          ) : bot ? (
            <Face bot={bot} size={43} />
          ) : (
            <span className="room-mark">
              {isGroupThread(item) ? (
                <UsersRound size={24} strokeWidth={1.3} />
              ) : (
                <MessageCircle size={24} strokeWidth={1.3} />
              )}
            </span>
          )}
          <span className="conversation-copy">
            <span className="conversation-heading">
              <strong>{item.title}</strong>
              {item.needsYou && <span className="needs-you-pill">Needs you</span>}
              {item.lastMessageAt && (
                <time>
                  {dayKey(item.lastMessageAt) === dayKey(new Date())
                    ? timeText(item.lastMessageAt)
                    : dateText(item.lastMessageAt)}
                </time>
              )}
            </span>
            {liveBot && liveAction ? (
              <span
                className="live-pill"
                title={liveAction}
                aria-label={`${liveBot.name} is live: ${liveAction}`}
              >
                {liveFaces.map((face) => (
                  <Face key={face.id} bot={face} size={18} />
                ))}
                <span className="live-text">{liveAction}</span>
                <span className="live-dots" aria-hidden="true"><i /><i /><i /></span>
              </span>
            ) : (
            <small
              title={
                bot && ["working", "waiting"].includes(bot.status) && bot.currentAction
                  ? bot.currentAction
                  : memberNames || undefined
              }
            >
              {bot && ["working", "waiting"].includes(bot.status) && bot.currentAction
                ? bot.currentAction
                : listSubtitle}
            </small>
            )}
          </span>
        </button>
        {actionCount > 0 && <button type="button" className="row-action-toggle" aria-label={`Conversation actions for ${item.title}`} aria-expanded={swipedRow === item.id} onClick={() => setSwipedRow(swipedRow === item.id ? null : item.id)}><MoreHorizontal size={16}/></button>}
        <span className="row-actions" aria-label={`Actions for ${item.title}`}>
          {item.id !== "team-room" && <button
            type="button"
            className="row-action row-action-pin"
            disabled={pendingThreads.includes(item.id)}
            aria-label={item.pinned ? `Unpin ${item.title}` : `Pin ${item.title} to the top`}
            aria-pressed={item.pinned}
            title={item.pinned ? "Unpin" : "Pin to the top"}
            onClick={() => { setSwipedRow(null); setPin(item, !item.pinned); }}
          >
            <Pin size={15} />
          </button>}
          {editRow && (
            <button
              type="button"
              className="row-action row-action-edit"
              aria-label={`Edit ${item.title}`}
              title="Edit"
              onClick={() => { setSwipedRow(null); editRow(); }}
            >
              <Pencil size={15} />
            </button>
          )}
          {item.id !== "team-room" && (
            <button
              type="button"
              disabled={pendingThreads.includes(item.id)}
              className={`row-action row-action-archive${archiveArmed === item.id ? " armed" : ""}`}
              aria-label={archiveArmed === item.id ? `Tap again to archive ${item.title}` : `Archive ${item.title}`}
              title={archiveArmed === item.id ? "Tap again to confirm" : "Archive"}
              onClick={() => void archiveThread(item)}
            >
              <Archive size={15} />
            </button>
          )}
        </span>
        </div>
      );
    };
  const conversationRows = (
    <>
      {visibleThreads.map((item, index) => {
        const group = conversationDayGroup(item.lastMessageAt ?? item.updatedAt);
        const startsGroup = index === 0 || group !== conversationDayGroup(visibleThreads[index - 1].lastMessageAt ?? visibleThreads[index - 1].updatedAt);
        return (
          <Fragment key={item.id}>
            {startsGroup && <span className="conversation-section-label">{group}</span>}
            {threadRow(item)}
          </Fragment>
        );
      })}
      {filteredConversationCount === 0 && (needsYouOnly || conversationQuery || Boolean(state?.bots.length)) && (
        <div className="conversation-list-empty" role="status">
          <img className="approved-face-mark" src="/design/openbot-face.svg" alt="" />
          <strong>{needsYouOnly ? "All caught up" : conversationQuery ? "No chats found" : "Start a conversation"}</strong>
          <span>{needsYouOnly ? "Your teammates will ask when they need you." : conversationQuery ? "Try another name or word." : "Choose a teammate and say hello."}</span>
          {conversationQuery && <button type="button" onClick={() => setConversationQuery("")}>Clear search</button>}
        </div>
      )}
      {archivedThreads.length > 0 && !needsYouOnly && !conversationQuery && (
        <details className="archived-chats">
          <summary>Archived ({archivedThreads.length})</summary>
          {archivedThreads.map((item) => (
            <div key={item.id} className="conversation-cell archived-cell">
              <button
                aria-label={item.title}
                title={item.title}
                className={`conversation-row ${page === "chat" && thread === item.id ? "current" : ""}`}
                onClick={() => openThread(item.id)}
              >
                <span className="conversation-title">{item.title}</span>
              </button>
              <button
                type="button"
                className="row-action row-action-unhide"
                disabled={pendingThreads.includes(item.id)}
                aria-label={`Unhide ${item.title}`}
                title="Unhide"
                onClick={() => void unhideThread(item)}
              >
                <Undo2 size={15} />
              </button>
            </div>
          ))}
        </details>
      )}
    </>
  );
  return (
    <div
      className={`studio-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${documentFile && page === "chat" ? "with-document" : ""} ${contextOpen && !narrow && page === "chat" ? "with-context" : ""} ${signInPane && !narrow && page === "chat" ? "with-sign-in" : ""}`}
    >
      <aside className="sidebar" aria-label={sidebarCollapsed ? "Collapsed conversation list" : "Conversation list"}>
        <a className="wordmark" href="/" title="Sidemates home">
          <img className="approved-face-mark" src="/design/openbot-face.svg" alt="" />
          <span className="wordmark-text">sidemates</span>
        </a>
        <button
          type="button"
          className="sidebar-collapse"
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={sidebarCollapsed}
          title={sidebarCollapsed ? "Expand sidebar (Cmd+B)" : "Collapse sidebar (Cmd+B)"}
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
        <label className="conversation-search">
          <Search size={16} />
          <input
            aria-label="Find a conversation"
            placeholder="Find a conversation"
            value={conversationQuery}
            onChange={(event) => setConversationQuery(event.target.value)}
          />
        </label>
        <div className="sidebar-conversations">
          <header>
            <span>Chats</span>
            <span className="conversation-new">
              <button
                className="compose-primary"
                aria-label="New conversation"
                title="New conversation"
                onClick={() => setDetail({ kind: state?.bots.length ? "new" : "create" })}
              >
                <Plus size={20} />
              </button>
            </span>
          </header>
          {Boolean(state?.bots.length) && (
            <div className="conversation-filters" aria-label="Filter conversations">
              <button aria-pressed={!needsYouOnly} onClick={() => setNeedsYouOnly(false)}>All</button>
              <button aria-pressed={needsYouOnly} onClick={() => setNeedsYouOnly(true)}>Needs you {attentionCount || ""}</button>
            </div>
          )}
          {activeNow.length > 0 && (
            <div className="active-now" aria-label="Working right now">
              {activeNow.map((bot) => (
                <button key={bot.id} type="button" className="active-now-chip" title={`${bot.name} is working right now`} onClick={() => openThread(bot.threadId)}>
                  <Face bot={bot} size={19} />
                  <span>{bot.name}</span>
                  <i aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
          {!needsYouOnly && !conversationQuery && Boolean(state?.bots.length) && <WaitingEntry count={state?.queueReady ?? 0} active={page === "waiting"} onOpen={() => navigate("waiting")} />}
          {!needsYouOnly && !conversationQuery && Boolean(state?.bots.length) && <WeeklyRecapEntry recap={state?.weeklyRecap} bots={allBots} face={(bot, size) => <Face bot={bot} size={size} />} />}
          {pinnedThreads.length > 0 && <section className="pinned-zone"><span className="conversation-section-label">Pinned</span>{pinnedThreads.map(threadRow)}</section>}
          {conversationRows}
        </div>
        <div className="sidebar-bottom">
          {sharing && <ShareResultSheet messageId={sharing} onClose={() => setSharing(null)} />}
          <SidebarExtras />
          <button
            className="workspace-link"
            aria-label="Open workspace"
            onClick={() => page === "chat" || page === "settings" ? openCapability("team") : setDetail({ kind: "workspace" })}
          >
            <Layers3 size={17} /> Workspace{" "}
            {attentionCount > 0 && <b>{attentionCount} {attentionCount === 1 ? "needs" : "need"} you</b>}
          </button>
          <div>
            <span className={`connection-dot ${online ? "" : "offline"}`} />
            <span>{online ? "Studio connected" : "Reconnecting"}</span>
            <button
              aria-label="Settings"
              className={page === "settings" ? "active" : ""}
              onClick={() => (page === "settings" ? navigate("chat") : openSettings())}
            >
              <Settings2 size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main className={`workspace workspace-${page}`}>
        <header className="topbar">
          <span className="topbar-left">
            <button
              className="topbar-control conversation-back"
              aria-label="All conversations"
              onClick={() => navigate("home")}
            >
              <ChevronLeft size={20} />
            </button>
          </span>
          <span className="topbar-center">
            {page === "settings" ? (
              <span className="conversation-name"><Settings2 size={17} /> Workspace</span>
            ) : conversationBot ? (
              <>
                <span
                  className="identity-mascot identity-tap"
                  aria-hidden="true"
                  onClick={() => setDetail({ kind: "teammate", bot: conversationBot })}
                >
                  <Face bot={conversationBot} size={44} />
                </span>
                <button
                  className="identity-pill"
                  aria-label={`About ${conversationBot.name}`}
                  onClick={() =>
                    setDetail({ kind: "teammate", bot: conversationBot })
                  }
                >
                  <span className="conversation-title-copy"><span className="conversation-name">{title}</span><small>{conversationBot.role}{conversationBot.model ? ` · ${conversationBot.aiMode === "automatic" ? "Auto · " : ""}${friendlyModelName(conversationBot.model)}` : ""}</small></span>
                  <ChevronDown size={13} />
                </button>
              </>
            ) : page === "chat" ? (
              <>
                <span
                  className="identity-mascot identity-stack identity-tap"
                  aria-hidden="true"
                  onClick={() =>
                    narrow ? setDetail({ kind: "context" }) : setContextOpen((value) => !value)
                  }
                >
                  {headerMembers.length > 0 ? (
                    headerMembers.map((member) => (
                      <Face key={member.id} bot={member} size={50} />
                    ))
                  ) : (
                    <UsersRound size={26} strokeWidth={1.3} />
                  )}
                </span>
                <button
                  className="identity-pill"
                  aria-label={`About ${title}`}
                  onClick={() =>
                    narrow ? setDetail({ kind: "context" }) : setContextOpen((value) => !value)
                  }
                >
                  <span className="conversation-name">{title}</span>
                  <ChevronDown size={13} />
                </button>
              </>
            ) : (
              title
            )}
          </span>
          <div className="topbar-right">
            {page === "settings" && <button className="workspace-return" onClick={() => openThread(thread)}>Back to conversation</button>}
            {page === "chat" && conversationBot && botReady && voiceModeSupported() && (
              <button className="topbar-control" aria-label={`Talk with ${conversationBot.name}`} title={`Talk with ${conversationBot.name} (voice is in beta)`} onClick={() => setVoiceOpen(true)}>
                <AudioLines size={19} strokeWidth={1.5} />
              </button>
            )}
            {page === "chat" && state?.bots.length ? (
              <button
                className="topbar-control"
                aria-label="Conversation details"
                onClick={() =>
                  narrow
                    ? setDetail({ kind: "context" })
                    : setContextOpen((value) => !value)
                }
              >
                <Monitor size={19} strokeWidth={1.5} />
              </button>
            ) : null}
            <button
              className="topbar-control mobile-search"
              aria-label="Search"
              onClick={() => setDetail({ kind: "search" })}
            >
              <Search size={18} />
            </button>
            {page === "chat" && conversationThread && <ConversationActions
              key={thread}
              thread={conversationThread}
              bot={conversationBot}
              onDetails={() => narrow ? setDetail({ kind: "context" }) : setContextOpen(true)}
              onWorkspace={() => setDetail({ kind: "workspace" })}
              onRemoved={() => { setRefresh((value) => value + 1); openThread("team-room"); }}
            />}
            {page !== "chat" && (
              <button
                className="topbar-control mobile-workspace"
                aria-label="Workspace"
                onClick={() => setDetail({ kind: "workspace" })}
              >
                <Layers3 size={19} strokeWidth={1.5} />
              </button>
            )}
          </div>
        </header>
        {threadActionError && <div className="error-banner" role="alert"><span>{threadActionError}</span><button onClick={() => setThreadActionError("")}>Dismiss</button></div>}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setRefresh((n) => n + 1)}>Try again</button>
            <button onClick={openSettings}>Settings</button>
          </div>
        )}
        {!state ? (
          <div className="loading">
            <LoaderCircle className="spin" size={22} />
            <p>Opening your studio…</p>
          </div>
        ) : (
          <>
            {page === "settings" && state && (
              <SettingsWorkspacePage
                onCreate={() => setDetail({ kind: "create" })}
                activePanel={capability || "team"}
                setActivePanel={(next) => openCapability(next)}
                state={state}
                thread={thread}
                appearance={appearance}
                setAppearance={(next) => setAppearance(next as Appearance)}
                onOpenCapability={(next, targetThread) => openCapability(next, targetThread)}
                onThread={(id) => openThread(id)}
                onRefresh={() => setRefresh((n) => n + 1)}
              />
            )}
            {page === "waiting" && <WaitingForYou queueReady={state?.queueReady} demoMac={state?.demoMac} firstLook={firstLook} onChanged={() => setRefresh((value) => value + 1)} />}
            {page === "home" && (
              <div className="page-content conversations-page">
                <div className="page-heading">
                  <div>
                    <p className="overline">PICK UP WHERE YOU LEFT OFF</p>
                    <h1>Conversations</h1>
                  </div>
                  <button
                    className="text-action"
                    onClick={() => setDetail({ kind: "create" })}
                  >
                    <Plus size={16} /> New teammate
                  </button>
                </div>
                <label className="conversation-search">
                  <Search size={16} />
                  <input
                    aria-label="Search conversations"
                    placeholder="Search conversations"
                    value={conversationQuery}
                    onChange={(event) =>
                      setConversationQuery(event.target.value)
                    }
                  />
                </label>
                <div className="favorite-teammates">
                  {recentTeammates(state.bots, state.threads).map((bot) => (
                    <button
                      key={bot.id}
                      onClick={() => openThread(bot.threadId)}
                    >
                      <Face bot={bot} size={68} />
                      <span>{bot.name}</span>
                    </button>
                  ))}
                </div>
                <div className="inbox-conversations">
          {!needsYouOnly && !conversationQuery && Boolean(state?.bots.length) && <WaitingEntry count={state?.queueReady ?? 0} active={false} onOpen={() => navigate("waiting")} />}
          {!needsYouOnly && !conversationQuery && Boolean(state?.bots.length) && <WeeklyRecapEntry recap={state?.weeklyRecap} bots={allBots} face={(bot, size) => <Face bot={bot} size={size} />} />}
          {pinnedThreads.length > 0 && <section className="pinned-zone"><span className="conversation-section-label">Pinned</span>{pinnedThreads.map(threadRow)}</section>}
                  {conversationRows}
                </div>
                {!state.bots.length && (
                  <Empty title="Your first conversation starts here">
                    Create a teammate with a job that matters to you.
                  </Empty>
                )}
              </div>
            )}
            {page === "activity" && (
              <div className="page-content activity-page">
                <div className="page-heading">
                  <div>
                    <p className="overline">YOUR TEAM’S WORK</p>
                    <h1>Activity</h1>
                  </div>
                  <span className="count-label">
                    {active.length} in progress
                  </span>
                </div>
                {attentionCount > 0 && (
                  <section className="attention-section">
                    <h2>
                      <ShieldCheck size={18} /> Needs you
                    </h2>
                    {attention.map(runRow)}
                    {uncertain.map((action) => (
                      <a
                        className="attention-notice"
                        key={action.id}
                        href="/?panel=live"
                      >
                        <strong>Check before continuing</strong>
                        <span>
                          {action.actionLabel} may have completed. It will not
                          be repeated automatically.
                        </span>
                        <small>Review and resolve →</small>
                      </a>
                    ))}
                    {alerts.map((alert) => (
                      <a
                        className="attention-notice"
                        key={alert.id}
                        href="/?panel=routines"
                      >
                        <strong>{alert.routineName}</strong>
                        <span>{alert.message}</span>
                        <small>Review routine →</small>
                      </a>
                    ))}
                    {otherApprovals.length > 0 && (
                      <a className="attention-notice" href="/?panel=live">
                        <strong>
                          {otherApprovals.length} pending action{" "}
                          {otherApprovals.length === 1 ? "review" : "reviews"}
                        </strong>
                        <span>
                          Open the complete review to inspect the full action before
                          deciding.
                        </span>
                      </a>
                    )}
                  </section>
                )}
                <section>
                  <div className="section-heading">
                    <h2>In progress</h2>
                  </div>
                  {active.map(runRow)}
                  {!active.length && (
                    <Empty title="No tasks running">
                      New tasks will appear here as your team starts working.
                    </Empty>
                  )}
                </section>
                <section>
                  <div className="section-heading">
                    <h2>Finished</h2>
                  </div>
                  {finished.slice(0, 20).map(runRow)}
                  {!finished.length && (
                    <p className="quiet-copy">
                      Finished work will stay here for you to revisit.
                    </p>
                  )}
                </section>
              </div>
            )}
            {page === "schedule" && (
              <div className="page-content schedule-page">
                <div className="page-heading">
                  <div>
                    <p className="overline">A LITTLE MORE AUTOMATIC</p>
                    <h1>Your schedule</h1>
                  </div>
                  <button
                    className="primary"
                    onClick={() =>
                      startPrompt(
                        "Help me create a routine. Ask what should happen and when before scheduling it.",
                      )
                    }
                  >
                    <Plus size={15} /> New routine
                  </button>
                </div>
                <div className="schedule-layout">
                  <section className="month-view">
                    <header>
                      <h2>
                        {Temporal.PlainDate.from(month).toLocaleString([], {
                          month: "long",
                          year: "numeric",
                        })}
                      </h2>
                      <div>
                        <button
                          aria-label="Previous month"
                          onClick={() =>
                            setMonth(
                              Temporal.PlainDate.from(month)
                                .subtract({ months: 1 })
                                .toString(),
                            )
                          }
                        >
                          <ChevronLeft size={17} />
                        </button>
                        <button
                          aria-label="Next month"
                          onClick={() =>
                            setMonth(
                              Temporal.PlainDate.from(month)
                                .add({ months: 1 })
                                .toString(),
                            )
                          }
                        >
                          <ChevronRight size={17} />
                        </button>
                      </div>
                    </header>
                    <div className="month-grid">
                      <div className="weekdays">
                        {["M", "T", "W", "T", "F", "S", "S"].map(
                          (day, index) => (
                            <span key={index}>{day}</span>
                          ),
                        )}
                      </div>
                      <div className="month-days">
                        {calendarMonthDays(month).map((day) => {
                          const key = day.toString(),
                            scheduled = upcoming.some(
                              (routine) => dayKey(routine.nextRunAt!) === key,
                            );
                          return (
                            <button
                              className={`${key.slice(0, 7) !== month.slice(0, 7) ? "outside" : ""} ${calendarDate === key ? "chosen" : ""}`}
                              key={key}
                              aria-label={day.toLocaleString([], {
                                dateStyle: "full",
                              })}
                              aria-pressed={calendarDate === key}
                              aria-current={
                                key === dayKey(new Date()) ? "date" : undefined
                              }
                              onClick={() => setCalendarDate(key)}
                            >
                              <span>{day.day}</span>
                              {scheduled && <i />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <p className="calendar-note">
                      Dots mark the next scheduled run of each routine.
                      <br />
                      Times shown in{" "}
                      {Intl.DateTimeFormat()
                        .resolvedOptions()
                        .timeZone.replaceAll("_", " ")}
                      .
                    </p>
                  </section>
                  <section className="day-agenda">
                    <p className="overline">
                      {Temporal.PlainDate.from(calendarDate).toLocaleString(
                        [],
                        { weekday: "long" },
                      )}
                    </p>
                    <h2>
                      {Temporal.PlainDate.from(calendarDate).toLocaleString(
                        [],
                        { month: "long", day: "numeric" },
                      )}
                    </h2>
                    {upcoming
                      .filter(
                        (routine) =>
                          dayKey(routine.nextRunAt!) === calendarDate,
                      )
                      .map(scheduleRow)}
                    {!upcoming.some(
                      (routine) => dayKey(routine.nextRunAt!) === calendarDate,
                    ) && (
                      <Empty title="Room to breathe">
                        No next runs on this date. Recurring schedules continue
                        beyond the next run shown here.
                      </Empty>
                    )}
                    <a className="text-action" href="/?panel=routines">
                      Manage all routines <ArrowRight size={14} />
                    </a>
                  </section>
                </div>
              </div>
            )}
            {page === "library" && (
              <div className="page-content library-page">
                <div className="page-heading">
                  <div>
                    <p className="overline">MAKE IT YOURS</p>
                    <h1>Your library</h1>
                  </div>
                </div>
                <div className="library-toolbar">
                  <div
                    className="tabs"
                    role="group"
                    aria-label="Library section"
                  >
                    <button
                      aria-pressed={libraryTab === "apps"}
                      onClick={() => {
                        setLibraryTab("apps");
                        setQuery("");
                      }}
                    >
                      Apps
                    </button>
                    <button
                      aria-pressed={libraryTab === "skills"}
                      onClick={() => {
                        setLibraryTab("skills");
                        setQuery("");
                      }}
                    >
                      Skills
                    </button>
                  </div>
                  <label className="library-search">
                    <Search size={16} />
                    <input
                      aria-label="Search library"
                      placeholder={`Find ${libraryTab === "apps" ? "an app" : "a skill"}`}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>
                </div>
                <p className="library-caption">
                  {libraryTab === "apps"
                    ? "Your apps, with you in control of what’s shared."
                    : "Useful methods your teammates can put to work."}
                </p>
                {libraryTab === "apps" ? (
                  <div className="app-list">
                    {connections?.catalog
                      .filter((app) =>
                        `${app.name} ${app.description}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .map((app) => (
                        <button
                          key={app.id}
                          className="app-row"
                          onClick={() => setDetail({ kind: "app", app })}
                        >
                          <span className="app-mark">
                            <ConnectorIcon id={app.id} />
                          </span>
                          <span>
                            <strong>{app.name}</strong>
                            <small>{app.description}</small>
                          </span>
                          <span className="app-state">
                            {app.connected ? (
                              <>
                                <Check size={13} /> Connected
                              </>
                            ) : app.availability === "next" ? (
                              "Coming later"
                            ) : (
                              "Not connected"
                            )}
                          </span>
                          <ChevronRight size={16} />
                        </button>
                      ))}
                    {!connections && (
                      <p className="quiet-copy">Loading your apps…</p>
                    )}
                    {connections &&
                      !connections.catalog.some((app) =>
                        `${app.name} ${app.description}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      ) && (
                        <Empty title="No matching apps">
                          Try a different name.
                        </Empty>
                      )}
                  </div>
                ) : (
                  <div className="skill-list">
                    {skills
                      .filter((skill) =>
                        `${skill.name} ${skill.description}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .map((skill) => (
                        <button
                          key={skill.id}
                          className="skill-row"
                          onClick={() => setDetail({ kind: "skill", skill })}
                        >
                          <span className="skill-number">
                            <FileText size={20} strokeWidth={1.3} />
                          </span>
                          <span>
                            <strong>{skill.name.replaceAll("-", " ")}</strong>
                            <small>{skill.description}</small>
                          </span>
                          <span className="skill-tag">
                            {skill.bundled ? "Included" : "Added by you"}
                          </span>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                    {query &&
                      !skills.some((skill) =>
                        `${skill.name} ${skill.description}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      ) && <Empty title="No matching skills" />}
                    <a className="text-action" href="/?panel=teach">
                      <Plus size={15} /> Teach your own skill
                    </a>
                  </div>
                )}
                {libraryTab === "skills" && (
                  <SkillDiscover query={query} refreshKey={refresh} onOpen={(entry) => setDetail({ kind: "discover", entry })} />
                )}
                <a className="text-action" href="/?panel=artifacts">
                  <FileText size={15} /> Browse artifacts your team delivered
                </a>
              </div>
            )}
            {page === "chat" && (
              <>
                <div
                  className="chat-scroll"
                  ref={messageScroll}
                  onScroll={() => {
                    const el = messageScroll.current!;
                    nearBottom.current =
                      el.scrollHeight - el.clientHeight - el.scrollTop < 100;
                  }}
                >
                  <div className="chat-messages">
                    {state.activeThreadId === thread && state.messages[0] && <div className="conversation-date">{dayKey(state.messages[0].createdAt) === dayKey(new Date()) ? "Today" : dateText(state.messages[0].createdAt)} · {timeText(state.messages[0].createdAt)}</div>}
                    {!state.bots.length ? (
                      <div className="first-teammate refined-welcome">
                        <div className="welcome-personality"><div className="welcome-faces"><Character name="Scout" variant="sprout" color="#299575" size={80}/><Character name="Pixel" variant="blob" color="#d86889" size={120}/><Character name="Nova" variant="nova" color="#6757d9" size={80}/></div><p className="welcome-tagline">A little help with the work.<br/>A little more room for you.</p></div>
                        <FirstRun onTeamReady={() => { setFirstLook(true); navigate("waiting"); }} onMakeOwn={() => setDetail({ kind: "create" })} onBringTeam={() => openCapability("team")} bringLabel={agentsToBringOver.count ? `Bring your ${agentsToBringOver.source} team (${agentsToBringOver.count})` : "Bring an existing teammate"} />
                      </div>
                    ) : state.activeThreadId !== thread ? (
                      <p className="quiet-copy">Opening conversation…</p>
                    ) : !state.messages.length ? (
                      <div className="chat-empty">
                        <FaceGroup
                          bots={
                            recipient
                              ? state.bots.filter((bot) => bot.id === recipient)
                              : state.bots
                          }
                          size={78}
                        />
                        <h1>What’s on your mind?</h1>
                        <p>
                          Start with a question or something you’d like done.
                        </p>
                        <ChatStarters onPick={pickStarter} jobs={conversationJobs} mac={Boolean(state?.settings.macAccessEnabled && navigator.userAgent.includes("Mac"))} />
                      </div>
                    ) : (<>{
                      state.messages.map((message, index) => {
                        if (actionGroupMemberIds.has(message.id)) return null;
                        const actionGroup = actionGroupByFirstId.get(message.id);
                        if (routineGroupMemberIds.has(message.id)) return null;
                        const routineGroup = routineGroupByFirstId.get(message.id);
                        if (routineGroup) {
                          const runs = routineGroup.filter((item) => item.eventType === "routine_run");
                          const replyFor = (item: Message) => routineGroup.find((reply) => reply.runId === item.runId && reply.id !== item.id);
                          return <div key={message.id} className="chat-event action-completed-group routine-run-group" role="status" data-event="routine_run">
                            <details><summary><Zap size={14} aria-hidden="true" /><span>{eventTitle(message).replace(/ started$/, "")} · ran {runs.length} times · last {timeText(runs[runs.length - 1]!.createdAt)}</span><ChevronDown size={14} aria-hidden="true" /></summary><div className="action-completed-records">{runs.map((item) => { const reply = replyFor(item); return <p key={item.id}><strong>{timeText(item.createdAt)}</strong><small>{eventDetail(item)}{reply ? ` · ${machineMarkerText(reply.body)}` : ""}</small></p>; })}</div></details>
                          </div>;
                        }
                        const cancelledOutcome = cancelledRunForTrigger(state.runs, state.messages, message.id);
                        // Event pills carry both teammates' mascots when the
                        // event names them — talking feels two-sided.
                        // Stops keep a single face.
                        const eventFaces = resolveEventFaces(
                          message.eventData || {},
                          allBots,
                          message.eventType === "run_stopped" ? 1 : 2,
                        );
                        const previous = index > 0 ? state.messages[index - 1] : undefined;
                        const startsGroup =
                          !previous ||
                          previous.senderId !== message.senderId ||
                          previous.senderType === "system" ||
                          message.senderType === "system";
                        // Stopping a task stops its helpers too: one line says so.
                        if (message.eventType === "run_stopped" && previous?.eventType === "run_stopped") return null;
                        if (message.eventType === "run_stopped" && state.messages[index + 1]?.eventType === "run_stopped") {
                          let last = index;
                          while (state.messages[last + 1]?.eventType === "run_stopped") last += 1;
                          const stops = state.messages.slice(index, last + 1);
                          const faces = [...new Map(stops.flatMap((item) => resolveEventFaces(item.eventData || {}, allBots, 1)).map((bot) => [bot.id, bot])).values()].slice(0, 3);
                          const stopped = state.runs.find((run) => run.id === message.runId && !run.parentRunId) || state.runs.find((run) => stops.some((item) => item.runId === run.id));
                          return <div key={message.id} className="chat-event" data-event="run_stopped" role="status">
                            <span className="chat-event-mark" aria-hidden="true">{faces.length ? faces.map((face) => <Face key={face.id} bot={face} size={20} />) : <MessageCircle size={14} />}</span>
                            <span><strong>{stops.length} tasks stopped</strong>{stopped && <> <button type="button" className="text-action" onClick={() => setDetail({ kind: "run", run: stopped })}>Review saved progress</button></>}</span>
                          </div>;
                        }
                        if (message.kind === "event") {
                          const foldFirst = talkFold.firstOf.get(message.id);
                          if (foldFirst && foldFirst.id !== message.id) return null;
                          const fold = talkFold.folds.get(message.id);
                          if (fold) {
                            const data = fold.first.eventData || {};
                            const from = String(data.fromName || "A teammate");
                            const to = String(data.toName || "a teammate");
                            return (
                              <Fragment key={message.id}>
                                <TalkPill
                                  faces={resolveEventFaces(data, allBots, 2)}
                                  title={`${from} ⇄ ${to}`}
                                  meta={`${fold.items.length} exchanges`}
                                  lines={fold.items.map((item) => eventDetail(item) || eventTitle(item))}
                                />
                              </Fragment>
                            );
                          }
                          return (                            <Fragment key={message.id}>{actionGroup ? <div className="chat-event action-completed-group" role="status" data-event="action_completed">
                              <details><summary><Check size={14} aria-hidden="true" /><span>{actionGroup.length} reviewed steps</span><ChevronDown size={14} aria-hidden="true" /></summary><div className="action-completed-records">{actionGroup.map((item) => <p key={item.id}><strong>{eventTitle(item)}</strong>{eventDetail(item) && <small>{eventDetail(item)}</small>}</p>)}</div></details>
                            </div> : ['handoff', 'teammate_message'].includes(message.eventType || '')
                              ? <TalkPill
                                  faces={eventFaces}
                                  title={eventTitle(message)}
                                  lines={eventDetail(message) ? [eventDetail(message)] : []}
                                />
                              : <div className="chat-event" data-event={message.eventType || "note"} role={['run_stopped', 'action_completed'].includes(message.eventType || '') ? 'status' : undefined}>
                              <span className="chat-event-mark" aria-hidden="true">
                                {eventFaces.length > 0 ? (
                                  eventFaces.map((face) => <Face key={face.id} bot={face} size={20} />)
                                ) : message.eventType === "routine_created" ? <Clock size={14} /> : message.eventType === "handoff" ? <ArrowRightLeft size={14} /> : message.eventType === "routine_run" ? <Zap size={14} /> : <MessageCircle size={14} />}
                              </span>
                              <span>
                                <strong>{eventTitle(message)}</strong>
                                {eventDetail(message) && <small>{eventDetail(message)}</small>}
                                {message.eventType === 'run_stopped' && (() => { const stopped = state.runs.find(run => run.id === message.runId); const asked = stopped ? (state.messages.find((item) => item.id === stopped.triggerMessageId)?.body || stopped.prompt) : ""; return <StopFix message={message} run={stopped} request={asked} openPanel={(panel) => openCapability(panel)} />; })()}
                                {message.eventType === 'run_stopped' && (() => { const stopped = state.runs.find(run => run.id === message.runId); return stopped && <> <button type="button" className="text-action" onClick={() => setDetail({kind: 'run', run: stopped})}>Review saved progress</button></>; })()}
                              </span>
                            </div>}{cancelledOutcome && <CancelledRunOutcome run={cancelledOutcome} onReview={() => setDetail({ kind: "run", run: cancelledOutcome })} />}</Fragment>
                          );
                        }
                        // Membership noise never earns a full bubble — quiet
                        // centered system line, like every real chat app.
                        if (message.senderType !== "user" && isMembershipText(message.body)) {
                          return (
                            <div key={message.id} className="chat-event is-centered" aria-label={message.body}>
                              <UsersRound size={13} aria-hidden="true" />
                              <span>{message.body}</span>
                            </div>
                          );
                        }
                        // Machine markers never earn a bubble either — one
                        // quiet centered line, humanized.
                        const marker =
                          message.senderType !== "user"
                            ? machineMarkerText(message.body)
                            : null;
                        if (marker) {
                          return (
                            <div key={message.id} className="chat-event is-centered" aria-label={message.body}>
                              <span>{marker}</span>
                            </div>
                          );
                        }
                        return (
                          <Fragment key={message.id}><article
                            style={{ "--message-tint": message.senderColor || "var(--secondary)" } as CSSProperties}
                            className={`chat-message ${message.senderType === "user" ? "from-you" : "from-team"} ${startsGroup ? "" : "continues"}`}

                          >
                            {message.senderType !== "user" && startsGroup && (
                              <div className="message-author">
                                <Character
                                  name={message.senderName}
                                  color={message.senderColor || "#7265cf"}
                                  variant={message.senderMascot || "nova"}
                                  size={31}
                                />
                                <strong>{message.senderName}</strong>
                                <time>{timeText(message.createdAt)}</time>
                              </div>
                            )}
                            <div className="prose" id={`message-text-${message.id}`}>
                              <MarkdownMessage body={message.body} attachments={message.attachments} />
                              {message.senderType === "bot" && state && !state.settings.macAccessEnabled && index === state.messages.length - 1 && /Files (?:&|and) apps on this Mac/i.test(message.body) && (
                                <MacAccessOffer name={message.senderName} threadId={message.threadId} onDone={() => setRefresh((n) => n + 1)} />
                              )}
                              {message.senderType === "bot" && (() => { const pane = privacyPaneIn(message.body); return pane && <button type="button" className="text-action message-open-setting" onClick={() => void fetch("/api/mac/open-settings", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pane }) })}>Open that setting</button>; })()}
                              {message.senderType === "bot" && !!message.progressUpdates?.length && (
                                <details className="message-work-updates">
                                  <summary>Work updates</summary>
                                  {message.progressUpdates.map((update, index) => <div key={index}><MarkdownMessage body={update} /></div>)}
                                </details>
                              )}
                            </div>
                            {message.replyTo && (
                              <div className="message-reply-context">
                                Replying to {message.replyTo.senderName}: {message.replyTo.body}
                              </div>
                            )}
                            <MessageControls
                              messageId={message.id}
                              reactions={message.reactions || []}
                              onReply={() => setReplyTo({ id: message.id, senderName: message.senderName, body: message.body })}
                              onReacted={() => setRefresh((n) => n + 1)}
                              readAloud={message.senderType === "bot" ? message.body : undefined}
                              onRetry={retryTarget?.replyId === message.id ? () => void retryReply() : undefined}
                              onShare={message.senderType === "bot" && message.runId && !state.runs.some((run) => run.id === message.runId && ["queued", "running", "awaiting_approval", "waiting_for_teammate"].includes(run.status)) ? () => setSharing(message.id) : undefined}
                              onEdit={lastOwnMessageId === message.id && !sending ? () => pickStarter(message.body) : undefined}
                            />
                            {message.senderType === "bot" && message.runId
                              ? <DeliveryCard onOpenDocument={file => { setContextOpen(false); setDocumentFile(file); }} message={message} run={state.runs.find((run) => run.id === message.runId)} childRuns={state.runs.filter((run) => run.parentRunId === message.runId)} teammates={state.bots} visibleFiles={conversationFiles} />
                              : <>{message.attachments.map((file) => <DeliveredFile key={file.id} file={file} />)}</>}
                            {lastTeamReplyId === message.id && <p className="message-honesty">AI can make mistakes, so check anything important.</p>}
                          </article>{cancelledOutcome && <CancelledRunOutcome run={cancelledOutcome} onReview={() => setDetail({ kind: "run", run: cancelledOutcome })} />}</Fragment>
                        );
                      })}
                      {!state.messages.some((message) => message.senderType === "user") && <ChatStarters onPick={pickStarter} jobs={conversationJobs} mac={Boolean(state?.settings.macAccessEnabled && navigator.userAgent.includes("Mac"))} />}
                    </>)}
                    {state.activeThreadId === thread && (() => {
                      const fallback = latestCancelledWithoutTrigger(state.runs, state.messages);
                      return fallback ? <CancelledRunOutcome run={fallback} dated onReview={() => setDetail({ kind: "run", run: fallback })} /> : null;
                    })()}
                    {state.activeThreadId === thread &&
                      state.approvals.filter((approval) => approval.status === "pending").map((approval) => {
                        const run = state.runs.find((item) => item.id === approval.runId);
                        return run ? <RunControls key={approval.id} run={run} approval={approval} onChange={() => setRefresh((value) => value + 1)} onSignInPane={page === "chat" ? (id) => setSignInPane(id) : undefined} /> : null;
                      })}
                    {state.activeThreadId === thread &&
                      state.runs
                        .filter(
                          (run) =>
                            !run.parentRunId &&
                            activeStates.includes(run.status),
                        )
                        .map((run) => (
                          <ConversationProgress key={run.id} run={liveTexts[run.id] && liveTexts[run.id]!.length >= (run.partialText?.length || 0) ? { ...run, partialText: liveTexts[run.id]! } : run} helpers={state.runs.filter((helper) => helper.parentRunId === run.id && [...activeStates, "awaiting_approval"].includes(helper.status))} onDetails={() => setDetail({ kind: "run", run })} onChange={() => setRefresh((value) => value + 1)} />
                        ))}
                    <div ref={messagesEnd} />
                  </div>
                </div>
                {state.bots.length > 0 && (
                  <div className="chat-compose">
                    {composer}
                    <p>
                      Connected apps and actions keep their existing permission
                      rules.
                    </p>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>
      {signInPane && !narrow && page === "chat" && (
        <aside className="browser-pane" aria-label="Private browser">
          <header>
            <h2>Private browser</h2>
            <button aria-label="Close the private browser" onClick={() => setSignInPane(null)}>
              <X size={19} />
            </button>
          </header>
          <BrowserSignInPanel key={signInPane} approvalId={signInPane} disabled={false}
            onBusyChange={() => {}} onInteraction={() => {}} />
        </aside>
      )}
      {signInPane && narrow && page === "chat" && (
        <div className="browser-pane browser-pane-narrow" role="dialog" aria-modal="true" aria-label="Private browser">
          <header>
            <button aria-label="Back to chat" onClick={() => setSignInPane(null)}>
              <ChevronLeft size={19} />
            </button>
            <h2>Private browser</h2>
            <span className="browser-pane-narrow-spacer" aria-hidden="true" />
          </header>
          <BrowserSignInPanel key={signInPane} approvalId={signInPane} disabled={false}
            onBusyChange={() => {}} onInteraction={() => {}} />
        </div>
      )}
      {contextOpen && !narrow && page === "chat" && state && (
        <aside
          className="conversation-context"
          aria-label="Conversation details"
        >
          <header>
            <h2>Details</h2>
            <button
              aria-label="Close conversation details"
              onClick={() => setContextOpen(false)}
            >
              <X size={19} />
            </button>
          </header>
          <ConversationContext
            state={state}
            bot={conversationBot}
            threadId={thread}
            onRun={(run) => setDetail({ kind: "run", run })}
            onSchedule={() => navigate("schedule")}
            onTakeover={setTakeoverBot}
            onEditGroup={thread.startsWith("group-") ? () => setDetail({ kind: "group", threadId: thread }) : undefined}
            yoloMode={yoloMode}
            safetyBusy={modeBusy}
            onToggleSafety={() => void toggleMode()}
          />
        </aside>
      )}
      {documentFile && page === "chat" && <DocumentPane key={documentFile.id} file={documentFile} files={conversationFiles} canRevise={composerDraft.ready} modal={narrow} onClose={() => setDocumentFile(null)} onRevise={file => { setDraft(`${draft}${draft ? "\n\n" : ""}Please revise ${file.name} (attachment ${file.id}, revision ${file.revision}): `); requestAnimationFrame(() => document.getElementById("studio-message")?.focus()); }} />}
      {detail && detail.kind !== "settings" && (
        <Drawer
          kind={detail.kind}
          onClose={() => setDetail(null)}
          title={
            detail.kind === "context"
              ? "Conversation details"
              : detail.kind === "group"
                ? detail.threadId ? "Conversation participants" : "New group"
              : detail.kind === "workspace"
                ? "Your workspace"
                : detail.kind === "new"
                  ? "New conversation"
                : detail.kind === "create"
                  ? "Create a teammate"
                  : detail.kind === "teammate"
                    ? `Meet ${detail.bot.name}`
                    
                      : detail.kind === "search"
                        ? "Search your studio"
                        : detail.kind === "run"
                          ? "The work"
                          : detail.kind === "app"
                            ? detail.app.name
                            : "Skill"
          }
        >
          {detail.kind === "context" && state && (
            <ConversationContext
              state={state}
              bot={conversationBot}
              threadId={thread}
              onRun={(run) => setDetail({ kind: "run", run })}
              onSchedule={() => navigate("schedule")}
              onTakeover={setTakeoverBot}
              onEditGroup={thread.startsWith("group-") ? () => setDetail({ kind: "group", threadId: thread }) : undefined}
              yoloMode={yoloMode}
              safetyBusy={modeBusy}
              onToggleSafety={() => void toggleMode()}
            />
          )}
          {detail.kind === "workspace" && (
            <nav className="workspace-menu" aria-label="Workspace navigation">
              {navItems.map(([key, label, Icon]) => (
                <button key={key} onClick={() => navigate(key)}>
                  <Icon size={19} />
                  <span>{label}</span>
                  {key === "activity" && attentionCount > 0 && (
                    <b>{attentionCount} {attentionCount === 1 ? "needs" : "need"} you</b>
                  )}
                  <ChevronRight size={16} />
                </button>
              ))}
              <button onClick={openSettings}>
                <Settings2 size={19} />
                <span>Settings & AI connections</span>
                <ChevronRight size={16} />
              </button>
            </nav>
          )}
          {detail.kind === "new" && state && (
            <div className="new-chat-chooser">
              <p>Pick a teammate and say what’s on your mind. They can ask another teammate for help when it fits.</p>
              <div className="new-chat-list" aria-label="Your teammates">
                {state.bots.map((bot) => (
                  <button type="button" key={bot.id} onClick={() => openThread(bot.threadId)}>
                    <Face bot={bot} size={36} />
                    <span><strong>{bot.name}</strong><small>{bot.role}</small></span>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
              <div className="new-chat-options">
                {state.bots.length > 1 && <button type="button" onClick={() => setDetail({ kind: "group", threadId: "" })}><UsersRound size={18} /> Start a group</button>}
                <button type="button" onClick={() => setDetail({ kind: "create" })}><Plus size={18} /> Create a teammate</button>
              </div>
            </div>
          )}
          {detail.kind === "create" && (
            <CreateTeammate
              onCreated={(bot) => {
                setDetail(null);
                setRecipient(bot.id);
                setThread(bot.threadId);
                setPage("chat");
                setRefresh((value) => value + 1);
              }}
            />
          )}
          {detail.kind === "group" && state && (
            <GroupEditor
              state={state}
              threadId={detail.threadId}
              onDone={() => setDetail(null)}
              onOpen={(id) => {
                setDetail(null);
                setRecipient("");
                setPage("chat");
                setThread(id);
                setRefresh((value) => value + 1);
              }}
            />
          )}
          {detail.kind === "teammate" && (
            <div className="meet-teammate">
              <Character
                name={detail.bot.name}
                color={detail.bot.color}
                variant={detail.bot.mascot}
                status={detail.bot.status}
                mood="happy"
                size={76}
              />
              <p className="overline">YOUR TEAMMATE</p>
              <h2 className="detail-title">{detail.bot.name}</h2>
              <p className="teammate-specialty">{detail.bot.role}</p>
              <a className="text-action" href={`/?thread=${encodeURIComponent(detail.bot.threadId)}&panel=bot`} onClick={(event) => { event.preventDefault(); openCapability("bot", detail.bot.threadId); }}><Settings2 size={14}/> Edit & manage teammate <ArrowRight size={14}/></a>
              <p className="drawer-intro">
                Talk to {detail.bot.name} directly, or ask the whole team. They
                can consult each other, with one teammate bringing you the final
                reply.
              </p>
              <div className="teammate-facts">
                <div>
                  <span>AI connection</span>
                  <strong>
                    {detail.bot.providerInstanceId && detail.bot.model
                      ? "Model selected"
                      : "Not set up yet"}
                  </strong>
                </div>
                <div>
                  <span>Files on this Mac</span>
                  <strong>
                    {detail.bot.macAccessEnabled &&
                    state?.settings.macAccessEnabled
                      ? "Permission enabled"
                      : "Not enabled"}
                  </strong>
                </div>
                <div>
                  <span>Browser access</span>
                  <strong>
                    {detail.bot.browserEnabled
                      ? "Permission enabled"
                      : "Not enabled"}
                  </strong>
                </div>
              </div>
              <p className="boundary-note">
                These are permission settings, not a connection test. Your
                accounts and the Mac’s permissions still apply.
              </p>
              <button
                className="primary full-width"
                onClick={() => openThread(detail.bot.threadId)}
              >
                Talk to {detail.bot.name}
                <ArrowRight size={15} />
              </button>
              <AppearanceEditor key={detail.bot.id} bot={detail.bot} onSaved={(bot) => { setDetail({ kind: "teammate", bot }); setRefresh((n) => n + 1); }}/>
            </div>
          )}
          {detail.kind === "search" && (
            <SearchStudio state={state} onOpen={openThread} />
          )}
          {detail.kind === "run" && (
            <>
              <div className="detail-owner">
                <Character
                  name={detail.run.botName}
                  color={detail.run.botColor}
                  variant={detail.run.botMascot}
                  size={55}
                />
                <span>
                  {detail.run.botName}
                  <small>{labelFor(detail.run.status)}</small>
                </span>
              </div>
              <h2 className="detail-title">{detail.run.task.goal}</h2>
              {detail.run.error && (
                <p className="detail-warning">{detail.run.error}</p>
              )}
              {detail.run.approvalReason && (
                <p className="detail-warning">{detail.run.approvalReason}</p>
              )}
              <ol className="task-steps">
                {detail.run.task.steps.map((step, index) => (
                  <li key={step.id}>
                    <span>
                      {step.status === "completed" ? (
                        <Check size={13} />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <div>
                      <strong>{step.title}</strong>
                      <small>{step.detail || step.status}</small>
                    </div>
                  </li>
                ))}
              </ol>
              {detail.run.summary && (
                <div className="prose">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.run.summary}</ReactMarkdown>
                </div>
              )}
              {!detail.run.summary && detail.run.partialText && <details className="message-work-updates"><summary>Latest work update</summary><div className="prose"><MarkdownMessage body={detail.run.partialText} /></div></details>}
              <DeliveryReceipt run={detail.run} teammates={state?.bots} />
              <WorkReceipt runId={detail.run.id} />
              <button
                className="primary full-width"
                onClick={() => openThread(detail.run.threadId)}
              >
                Open conversation <ArrowRight size={15} />
              </button>
              <RunControls key={detail.run.id} run={detail.run} approval={state?.approvals.find((approval) => approval.id === detail.run.approvalId)} onChange={() => setRefresh((value) => value + 1)} />
              <p className="boundary-note">
                Opening a result does not approve or restart a task.
              </p>
            </>
          )}
          {detail.kind === "app" && (
            <>
              <div className="detail-app-mark">
                <ConnectorIcon id={detail.app.id} />
              </div>
              <h2 className="detail-title">
                {detail.app.availability === "next"
                  ? `${detail.app.name} is coming later`
                  : detail.app.connected
                    ? `${detail.app.name} is connected`
                    : `Connect ${detail.app.name}`}
              </h2>
              <p className="drawer-intro">{detail.app.description}</p>
              <div className="capability-list">
                {detail.app.capabilities.map((capability) => (
                  <p key={capability}>
                    <Check size={15} />
                    {capability}
                  </p>
                ))}
              </div>
              <p className="boundary-note">
                An app connection does not automatically give every teammate
                access. Existing permission and approval rules stay in place.
              </p>
              <details className="browser-access-card"><summary><Monitor size={15}/> Can I use the website instead?</summary>
                <p>Yes, for tasks the website and browser support. Open your teammate’s computer and sign in yourself; its browser profile can keep that session for later.</p>
                <p>Connections give reliable structured access for searches and recurring work. A saved browser login is a separate path, not proof of API access. Reading restrictions and action approvals still apply.</p>
                {conversationBot && (
                  <button className="text-action" onClick={() => setTakeoverBot(conversationBot)}>
                    Open computer controls <ArrowRight size={14} />
                  </button>
                )}
              </details>
              {detail.app.availability !== "next" && (
                <a className="primary full-width" href="/?panel=connectors">
                  {detail.app.connected
                    ? "Manage connection"
                    : "Open connection setup"}
                  <ArrowRight size={15} />
                </a>
              )}
              <p className="boundary-note">
                {detail.app.availability === "next"
                  ? "This connector is not available yet. No account connection will be started."
                  : "Choose how this app connects to your studio."}
              </p>
            </>
          )}
          {detail.kind === "discover" && (
            <SkillDiscoverDetail
              key={detail.entry.url}
              entry={detail.entry}
              bots={state?.bots || []}
              face={(bot) => <Face bot={bot} size={30} />}
              onAdded={() => { setDetail(null); setRefresh((value) => value + 1); }}
            />
          )}
          {detail.kind === "skill" && (
            <>
              <p className="overline">
                {detail.skill.bundled ? "INCLUDED METHOD" : "YOUR METHOD"}
              </p>
              <h2 className="detail-title">
                {detail.skill.name.replaceAll("-", " ")}
              </h2>
              <p className="drawer-intro">{detail.skill.description}</p>
              <h3 className="detail-subtitle">Available to</h3>
              <div className="skill-people">
                {state?.bots
                  .filter((bot) => detail.skill.botIds.includes(bot.id))
                  .map((bot) => (
                    <div key={bot.id}>
                      <Face bot={bot} size={39} />
                      <span>{bot.name}</span>
                    </div>
                  ))}
              </div>
              <details className="source-details">
                <summary>Read the instructions</summary>
                <div className="prose">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.skill.instructions}</ReactMarkdown>
                </div>
              </details>
              <small className="boundary-note">
                {detail.skill.license} ·{" "}
                {detail.skill.bundled ? "Included" : "Imported"} · No new
                account access
              </small>
              <a className="text-action" href="/?panel=teach">
                Manage skill access <ArrowRight size={14} />
              </a>
            </>
          )}
        </Drawer>
      )}
      {voiceOpen && conversationBot && state && (
        <VoiceMode
          bot={conversationBot}
          messages={state.messages.filter((message) => message.threadId === conversationBot.threadId)}
          runs={[...state.runs, ...state.studioRuns]}
          onClose={() => setVoiceOpen(false)}
          onSend={async (text) => {
            await api("/api/messages", {
              threadId: conversationBot.threadId,
              body: text,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              targetBotIds: [],
              attachmentIds: [],
              replyToId: null,
              requestId: `voice-${conversationBot.id}-${Date.now()}`,
            });
            setRefresh((n) => n + 1);
          }}
        />
      )}
      {takeoverBot && (
        <ComputerTakeover bot={takeoverBot} onClose={() => setTakeoverBot(null)} />
      )}
    </div>
  );
}

function Drawer({
  kind,
  title,
  children,
  onClose,
  onBack,
  settings = false,
}: {
  kind?: string;
  title: string;
  children: ReactNode;
  onClose: () => void;
  onBack?: () => void;
  settings?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const prior = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      prior?.focus();
    };
  }, []);
  useEffect(() => {
    // A subpage starts at its heading, never at the previous panel's scroll.
    ref.current?.scrollTo({ top: 0 });
    ref.current?.querySelector(".drawer-body")?.scrollTo({ top: 0 });
  }, [title]);
  return (
    <dialog
      ref={ref}
      className={`detail-drawer detail-${kind || "default"}${settings ? " settings-drawer" : ""}`}
      aria-label={title}
      onCancel={onClose}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const r = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <header>
        {onBack ? (
          <div className="drawer-header-nav">
            <button
              type="button"
              className="drawer-back"
              aria-label="Back to settings"
              onClick={onBack}
            >
              <ChevronLeft size={16} />
              <span>Settings</span>
            </button>
            <span className="drawer-breadcrumb-sep" aria-hidden="true">/</span>
            <h2>{title}</h2>
          </div>
        ) : (
          <h2>{title}</h2>
        )}
        <button
          type="button"
          autoFocus
          className="drawer-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="drawer-body">{children}</div>
    </dialog>
  );
}
function SearchStudio({
  state,
  onOpen,
}: {
  state: AppState | null;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const matches =
    state?.threads.filter(
      (thread) =>
        !thread.hidden &&
        thread.title.toLowerCase().includes(query.toLowerCase()),
    ) || [];
  return (
    <>
      <label className="search-dialog-input">
        <Search size={19} />
        <input
          autoFocus
          aria-label="Search conversations"
          placeholder="Find a conversation"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="search-results">
        {matches.map((thread) => (
          <button key={thread.id} onClick={() => onOpen(thread.id)}>
            <MessageCircle size={17} />
            <span>{thread.title}</span>
            <ArrowRight size={15} />
          </button>
        ))}
        {!matches.length && (
          <Empty title="No conversations found">Try a teammate’s name.</Empty>
        )}
      </div>
    </>
  );
}
