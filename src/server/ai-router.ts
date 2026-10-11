import { isBlockedFreeTierModel, mayTrainOnPrompts } from "../shared/provider-config.js";

/** Automatic AI: a teammate set to "automatic" works on the best AI the owner
 * has connected, chosen per job, and moves to the next one when an AI runs
 * out of allowance. Nobody has to pick a model. */

export type AiJob = "light" | "heavy";

export interface AiConnection { id: string; provider: string; connected: boolean; models: string[] }
export interface AiPick { instanceId: string; model: string }

/** Small, single-step requests go to a fast model and save the strong
 * allowance; anything that browses, reads files, runs on a schedule or
 * produces a report gets the strongest model available. */
export function classifyJob(input: { prompt: string; expectedWorkKind?: string | null; browserEnabled: boolean; attachments: number; routine: boolean }): AiJob {
  if (input.expectedWorkKind || input.routine || input.attachments > 0) return "heavy";
  const prompt = input.prompt.trim();
  if (prompt.length > 280) return "heavy";
  if (input.browserEnabled && /\b(research|look up|find out|search|compare|browse|website|web|news|sources?|book|buy|order)\b/i.test(prompt)) return "heavy";
  if (/\b(plan|report|analy[sz]e|write|draft|document|spreadsheet|summari[sz]e)\b/i.test(prompt) && prompt.length > 120) return "heavy";
  return "light";
}

const newestFirst = (models: string[]) => [...models].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
const first = (models: string[], ...patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const found = newestFirst(models.filter((model) => pattern.test(model)));
    if (found.length) return found[0];
  }
  return undefined;
};

/** The model a connection should use for a job, or undefined if it offers
 * nothing usable. Never a model that fails for teammates or trains on prompts. */
export function bestModelFor(connection: AiConnection, job: AiJob): string | undefined {
  const usable = connection.models.filter((model) => !isBlockedFreeTierModel(model) && !mayTrainOnPrompts(model));
  if (!usable.length) return undefined;
  const heavy = job === "heavy";
  switch (connection.provider) {
    case "claude":
      return heavy ? first(usable, /\/sonnet$/, /\/opus$/, /./) : first(usable, /\/haiku$/, /\/sonnet$/, /./);
    case "openai":
      // ChatGPT through OpenCode ("openai/gpt-5.6") or through Sign in with
      // ChatGPT ("openbot-chatgpt-plan/gpt-6.1-sol"): strong ones for big jobs.
      return heavy
        ? first(usable, /^openai\/gpt-\d+(?:\.\d+)*$/, /\/gpt-\d+(?:\.\d+)*(?:-(?!mini|nano|lite)[a-z]+)?$/, /codex/i, /./)
        : first(usable, /^openai\/gpt-[\d.]+-mini$/, /\/gpt-[\d.]+-(?:mini|nano)$/, /mini/i, /^openai\/gpt-\d+(?:\.\d+)*$/, /\/gpt-\d+(?:\.\d+)*(?:-[a-z]+)?$/, /./);
    case "google":
      // A free key allows few requests a day on the bigger models; Flash-Lite lasts longest.
      return heavy ? first(usable, /gemini-flash-latest$/, /gemini-[\d.]+-flash$/, /flash-lite/, /./) : first(usable, /flash-lite/, /flash/, /./);
    case "github-copilot":
      return heavy ? first(usable, /claude-sonnet/, /gpt-\d+(?:\.\d+)*$/, /./) : first(usable, /mini/, /haiku/, /./);
    case "xai":
      return heavy ? first(usable, /grok-\d+(?:\.\d+)*$/, /./) : first(usable, /fast/, /mini/, /./);
    case "opencode":
      return first(usable, /deepseek-v4\.1-flash$/, /deepseek-v4-flash$/, /^opencode-go\//, /./);
    default:
      return usable[0];
  }
}

/** Strongest first for big jobs; for small ones, the plans that cost the
 * least of the owner's strong allowance come first. A local or custom
 * connection is a last resort for heavy work and fine for light work. */
// Apple's built-in AI is always last: free and private, but without tools,
// so it only takes a job when nothing else can.
const ORDER: Record<AiJob, string[]> = {
  heavy: ["claude", "openai", "github-copilot", "xai", "opencode", "google", "gitlab", "custom", "apple"],
  light: ["claude", "openai", "opencode", "google", "github-copilot", "xai", "custom", "gitlab", "apple"],
};

export function rankAi(connections: AiConnection[], job: AiJob, isResting: (id: string) => boolean = () => false): AiPick[] {
  const rank = (provider: string) => {
    const index = ORDER[job].indexOf(provider);
    return index < 0 ? ORDER[job].length : index;
  };
  return connections
    .filter((connection) => connection.connected && !isResting(connection.id))
    .sort((a, b) => rank(a.provider) - rank(b.provider))
    .flatMap((connection) => {
      const model = bestModelFor(connection, job);
      return model ? [{ instanceId: connection.id, model }] : [];
    });
}

/** The connected AIs from a provider status, in the shape the router needs. */
export function connectionsFrom(status: { instances?: Array<{ id: string; provider: string; connected?: boolean; models?: string[] }> } | null): AiConnection[] {
  return (status?.instances || []).map((instance) => ({ id: instance.id, provider: instance.provider, connected: Boolean(instance.connected), models: instance.models || [] }));
}

/** Errors that mean "this AI is out of allowance for now", not "the job is wrong". */
export function isLimitError(text: string): boolean {
  return /\b(429|rate[ -]?limit\w*|usage limit|quota|insufficient_quota|limit (?:reached|exceeded)|exceeded your|too many requests|out of (?:credits|usage)|weekly allowance|subscription_sharing_usage_limit_exceeded|resource[_ ]exhausted|overloaded)\b/i.test(text);
}

/** Connections that hit their limit rest for a while before being tried again. */
export class AiRest {
  private readonly until = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  rest(id: string, ms = 60 * 60_000) { this.until.set(id, this.now() + ms); }
  isResting = (id: string) => {
    const until = this.until.get(id);
    if (until === undefined) return false;
    if (until <= this.now()) { this.until.delete(id); return false; }
    return true;
  };
}

export const aiRest = new AiRest();
