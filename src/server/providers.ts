import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { ProviderCatalogEntry, ProviderInstance, ProviderLoginAttempt, ProviderStatus } from "../shared/types.js";
import { OpenBotDatabase } from "./database.js";
import { safeHostEnvironment } from "./runtime.js";
import { chatgptPlanSignedIn, CHATGPT_PLAN_ID } from "./chatgpt-plan.js";
import { APPLE_MODEL, appleAiStatus } from "./apple-ai.js";
import { configuredModels, legacyApiProviderId, isBlockedFreeTierModel, isLocalModelUrl, mayTrainOnPrompts } from "../shared/provider-config.js";

/** Shown when an OpenCode sign-in lists no models. OpenCode's own free models
 * return 403 for teammate runs (qa/prompt-eval), so they are never offered
 * as a stand-in. */
export const OPENCODE_NO_MODELS_NOTE = "Signed in, but OpenCode lists no models Sidemates can use. OpenCode's free models only answer inside OpenCode's own app. Add OpenCode Go, or connect ChatGPT, a free Google Gemini key or Claude Code instead.";

type CommandResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };
type OAuthAuthorization = { url: string; method: "auto" | "code"; instructions: string; methodIndex: number };

export function oauthMethodIndex(methods: unknown): number {
  if (!Array.isArray(methods)) throw new Error("This runtime does not offer account sign-in for that provider. Use an API key instead.");
  const index = methods.findIndex((method) => method && typeof method === "object" && method.type === "oauth");
  if (index < 0) throw new Error("This runtime does not offer account sign-in for that provider. Use an API key instead.");
  return index;
}

function stripAnsi(value: string) {
  return value.replace(/\x1b\[[0-9;]*m/g, "").replace(/[│●┌└]/g, " ");
}

function execute(command: string, args: string[], timeoutMs = 15_000, environment: Record<string, string> = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false, stdout = "", stderr = "";
    const child = spawn(command, args, { env: safeHostEnvironment(environment), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => (stdout = (stdout + String(chunk)).slice(-1_000_000)));
    child.stderr.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-20_000)));
    // Discovery must not hang forever if a damaged runtime ignores SIGTERM.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }); } });
    child.on("close", (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr, ...(timedOut ? { timedOut } : {}) }); } });
  });
}

/** A check that ran out of time says nothing about the connection (OpenCode
 * may be refreshing its model list, or the Mac is busy). Keep the last answer
 * instead of letting connected AIs vanish from every list for a while. A real
 * answer, such as "not signed in", always replaces it. */
const lastAnswers = new Map<string, CommandResult>();
export async function steadyCheck(key: string, run: () => Promise<CommandResult>): Promise<CommandResult> {
  const result = await run();
  if (!result.timedOut) { lastAnswers.set(key, result); return result; }
  return lastAnswers.get(key) ?? result;
}
/** A fresh app's first check reported its own bundled OpenCode as "not
 * installed"; a check a minute later found it. The first run of a newly
 * installed program is slower while macOS inspects it (a fresh copy of the
 * 144 MB OpenCode took 2 s here against 0.4 s after; a downloaded app is
 * inspected more thoroughly) and start-up is busy. With no earlier answer to
 * fall back on, the first check waits up to a minute instead of 15 seconds. */
export const checkTimeout = (key: string) => lastAnswers.has(key) ? 15_000 : 60_000;
const check = (command: string, args: string[]) => { const key = `${command} ${args.join(" ")}`; return steadyCheck(key, () => execute(command, args, checkTimeout(key))); };

const apiModelCache = new Map<string, { expiresAt: number; models: string[] }>();

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error("Could not reserve a local sign-in port.")));
    });
  });
}

function modelLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[a-z0-9._-]+\/[a-z0-9._:/-]+$/i.test(line)))];
}

function agentModels(models: string[]): string[] {
  return models.filter((model) => !/(?:^|[-/])(image|embedding|realtime|audio|tts|transcri)/i.test(model));
}

/** The model a connection uses by default. Never a model that answers 403
 * for teammate runs; a model that may train on prompts only when nothing
 * else is offered. */
export function preferredModel(provider: ProviderInstance["provider"], models: string[]): string | undefined {
  if (provider === "opencode") {
    const usable = models.filter((model) => !isBlockedFreeTierModel(model));
    return usable.find((model) => model === "opencode-go/deepseek-v4.1-flash") || usable.find((model) => model === "opencode-go/deepseek-v4-flash") || usable.find((model) => !mayTrainOnPrompts(model)) || usable[0];
  }
  if (provider === "claude") return models.find((model) => model.endsWith("/sonnet")) || models[0];
  // Google retires versions for new keys; the "latest" aliases follow the
  // current one. Flash-Lite first: a free key allows only ~20 Flash requests a
  // day, and one task can take ten.
  if (provider === "google") return models.find((model) => model === "google/gemini-flash-lite-latest") || models.find((model) => model === "google/gemini-flash-latest") || [...models].filter((model) => /^google\/gemini-[\d.]+-flash$/.test(model)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] || models[0];
  if (provider === "openai") {
    const baseModels = models.filter((model) => /^openai\/gpt-\d+(?:\.\d+)*$/.test(model));
    return baseModels.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] || models.find((model) => /codex/i.test(model)) || models[0];
  }
  return models[0];
}

export function modelsFor(provider: ProviderInstance["provider"], allModels: string[]): string[] {
  const prefixes: Record<ProviderInstance["provider"], string[]> = {
    opencode: ["opencode/", "opencode-go/"], claude: ["claude-code/"], openai: ["openai/"],
    "github-copilot": ["github-copilot/"], gitlab: ["gitlab/"], xai: ["xai/"], google: ["google/"], apple: [], custom: [],
  };
  const selected = agentModels(allModels.filter((model) => prefixes[provider].some((prefix) => model.startsWith(prefix))));
  if (provider === "claude") return ["claude-code/sonnet", "claude-code/opus", "claude-code/haiku"];
  if (provider === "apple") return [APPLE_MODEL];
  return selected;
}

function apiKeyModels(instance: ProviderInstance, allModels: string[]): string[] {
  const env = instance.envName || "";
  const prefix = env === "ANTHROPIC_API_KEY" ? "anthropic/" : env === "OPENROUTER_API_KEY" ? "openrouter/" : env === "OPENAI_API_KEY" ? "openai/" : "";
  return agentModels(prefix ? allModels.filter((model) => model.startsWith(prefix)) : []);
}

function apiProviderId(instance: ProviderInstance): string | null {
  if (instance.envName === "ANTHROPIC_API_KEY") return "anthropic";
  if (instance.envName === "OPENROUTER_API_KEY") return "openrouter";
  if (instance.envName === "OPENAI_API_KEY") return "openai";
  return instance.provider !== "custom" ? instance.provider : null;
}

function authHas(auth: string, pattern: RegExp) {
  return pattern.test(stripAnsi(auth));
}

function connectedInstance(db: OpenBotDatabase, input: Parameters<OpenBotDatabase["upsertProvider"]>[0]) {
  const current = input.id ? db.getProvider(input.id) : null;
  if (current && current.name === input.name && current.provider === input.provider && current.authMode === input.authMode && current.runtime === input.runtime) return current;
  return db.upsertProvider(input);
}

let latestStatus: ProviderStatus | null = null;
/** The most recent provider status, without waiting for a new check. */
export const latestProviderStatus = () => latestStatus;

export function createProviderStatusReader(inspect: (db: OpenBotDatabase, attempts: ProviderLoginAttempt[]) => Promise<ProviderStatus>, ttlMs = 15_000) {
  const cache = new WeakMap<OpenBotDatabase, { key: string; expires: number; pending: boolean; promise: Promise<ProviderStatus> }>();
  return (db: OpenBotDatabase, loginAttempts: ProviderLoginAttempt[] = []): Promise<ProviderStatus> => {
    const key = JSON.stringify({ attempts: loginAttempts, connections: db.listProviders().filter((entry) => entry.authMode === "api_key") });
    const current = cache.get(db);
    if (current?.key === key && (current.pending || current.expires > Date.now())) return current.promise;
    const entry = { key, expires: 0, pending: true, promise: Promise.resolve(null as unknown as ProviderStatus) };
    entry.promise = inspect(db, loginAttempts).then((result) => {
      entry.pending = false; entry.expires = Date.now() + ttlMs; latestStatus = result; return result;
    }).catch((error) => { if (cache.get(db) === entry) cache.delete(db); throw error; });
    cache.set(db, entry);
    return entry.promise;
  };
}

async function inspectProviderStatus(db: OpenBotDatabase, loginAttempts: ProviderLoginAttempt[] = []): Promise<ProviderStatus> {
  const [openCodeVersion, claudeVersion, apple] = await Promise.all([check("opencode", ["--version"]), check("claude", ["--version"]), appleAiStatus()]);
  const openCodeInstalled = openCodeVersion.code === 0;
  const claudeInstalled = claudeVersion.code === 0;
  const [auth, models, claudeAuth] = await Promise.all([
    openCodeInstalled ? check("opencode", ["auth", "list"]) : Promise.resolve({ code: 1, stdout: "", stderr: "" }),
    openCodeInstalled ? check("opencode", ["models"]) : Promise.resolve({ code: 1, stdout: "", stderr: "" }),
    claudeInstalled ? check("claude", ["auth", "status"]) : Promise.resolve({ code: 1, stdout: "", stderr: "" }),
  ]);
  let allModels = modelLines(models.stdout);
  const openCodeConnected = auth.code === 0 && authHas(auth.stdout, /OpenCode(?: Go| Zen)?\s+api/i);
  const openAIConnected = auth.code === 0 && authHas(auth.stdout, /OpenAI\s+(?:api|oauth)/i);
  const copilotConnected = auth.code === 0 && authHas(auth.stdout, /GitHub Copilot\s+(?:api|oauth)/i);
  const gitlabConnected = auth.code === 0 && authHas(auth.stdout, /GitLab\s+(?:api|oauth)/i);
  const xaiConnected = auth.code === 0 && authHas(auth.stdout, /xAI\s+(?:api|oauth)/i);
  const googleConnected = auth.code === 0 && authHas(auth.stdout, /Google\s+api/i);
  let claudeConnected = false;
  try { claudeConnected = Boolean(JSON.parse(claudeAuth.stdout || "{}").loggedIn); } catch { claudeConnected = /logged.?in\D+true/i.test(claudeAuth.stdout); }

  if (openCodeConnected) connectedInstance(db, { id: "local-opencode", name: "OpenCode", provider: "opencode", authMode: "cli", runtime: "opencode" });
  if (openAIConnected) connectedInstance(db, { id: "local-openai", name: "ChatGPT / OpenAI", provider: "openai", authMode: "subscription", runtime: "opencode" });
  if (copilotConnected) connectedInstance(db, { id: "local-github-copilot", name: "GitHub Copilot", provider: "github-copilot", authMode: "subscription", runtime: "opencode" });
  if (gitlabConnected) connectedInstance(db, { id: "local-gitlab", name: "GitLab Duo", provider: "gitlab", authMode: "subscription", runtime: "opencode" });
  if (googleConnected) connectedInstance(db, { id: "local-google", name: "Google Gemini", provider: "google", authMode: "cli", runtime: "opencode" });
  if (xaiConnected) connectedInstance(db, { id: "local-xai", name: "SuperGrok / xAI", provider: "xai", authMode: "subscription", runtime: "opencode" });
  if (claudeConnected) connectedInstance(db, { id: "local-claude", name: "Claude", provider: "claude", authMode: "subscription", runtime: "claude_code" });
  if (apple.available) connectedInstance(db, { id: "local-apple", name: "Apple Intelligence", provider: "apple", authMode: "subscription", runtime: "apple_fm" });

  const apiInstances = db.listProviders().filter((instance) => instance.authMode === "api_key" && instance.hasSecret);
  const apiModels = new Map<string, string[]>();
  await Promise.all(apiInstances.map(async (instance) => {
    if (instance.apiConfig || !openCodeInstalled) return;
    const cacheKey = `${instance.id}:${instance.updatedAt}`, cached = apiModelCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) { apiModels.set(instance.id, cached.models); return; }
    const providerId = apiProviderId(instance);
    if (!providerId) return;
    const result = await execute("opencode", ["models", providerId], 15_000, db.providerEnvironmentById(instance.id));
    const found = modelLines(result.stdout);
    apiModelCache.set(cacheKey, { expiresAt: Date.now() + 60_000, models: found });
    apiModels.set(instance.id, found);
  }));
  allModels = [...new Set([...allModels, ...[...apiModels.values()].flat()])];

  const catalog: ProviderCatalogEntry[] = [
    { id: "opencode", name: "OpenCode", shortName: "OpenCode", description: "OpenCode Go models through your OpenCode account.", badge: "OpenCode Go", connected: openCodeConnected, installed: openCodeInstalled, canConnect: false, connectionId: openCodeConnected ? "local-opencode" : null, models: modelsFor("opencode", allModels), note: openCodeConnected ? modelsFor("opencode", allModels).length ? "Sign-in found on this Mac; model access is checked when a task runs." : OPENCODE_NO_MODELS_NOTE : openCodeInstalled ? "Connect from OpenCode once, then come back here." : "Install OpenCode first." },
    { id: "claude", name: "Claude", shortName: "Claude", description: "Uses the Claude Code you installed and signed in to, with your Pro, Max, Team, Enterprise or Console plan.", badge: "Claude Code", connected: claudeConnected, installed: claudeInstalled, canConnect: claudeInstalled, connectionId: claudeConnected ? "local-claude" : null, models: modelsFor("claude", allModels), note: claudeConnected ? "Signed in through Claude Code" : claudeInstalled ? "Sign in without sharing a password with Sidemates." : "Install Claude Code first." },
    { id: "openai", name: "ChatGPT / OpenAI", shortName: "ChatGPT", description: "Use ChatGPT Plus/Pro OAuth or your existing OpenAI connection.", badge: "Subscription", connected: openAIConnected, installed: openCodeInstalled, canConnect: openCodeInstalled, connectionId: openAIConnected ? "local-openai" : null, models: modelsFor("openai", allModels), note: openAIConnected ? "Sign-in found through OpenCode; model access is checked when a task runs." : "Browser sign-in through OpenCode." },
    { id: "github-copilot", name: "GitHub Copilot", shortName: "Copilot", description: "Use the models included with Copilot Pro, Pro+ or Business. Copilot Free and Student plans can't be used by apps right now.", badge: "Subscription", connected: copilotConnected, installed: openCodeInstalled, canConnect: openCodeInstalled, connectionId: copilotConnected ? "local-github-copilot" : null, models: modelsFor("github-copilot", allModels), note: copilotConnected ? (modelsFor("github-copilot", allModels).length ? "Sign-in found through OpenCode; model access is checked when a task runs." : "Signed in, but this Copilot plan doesn't offer models to apps (Free and Student plans). Use Gemini's free key or another account.") : "Connect a GitHub.com account." },
    { id: "gitlab", name: "GitLab Duo", shortName: "GitLab", description: "Connect a GitLab Duo seat for agent work.", badge: "Experimental", connected: gitlabConnected, installed: openCodeInstalled, canConnect: openCodeInstalled, connectionId: gitlabConnected ? "local-gitlab" : null, models: modelsFor("gitlab", allModels), note: gitlabConnected ? "Sign-in found through OpenCode; model access is checked when a task runs." : "GitLab support in OpenCode is experimental." },
    { id: "xai", name: "SuperGrok / xAI", shortName: "Grok", description: "Use SuperGrok device login or an xAI API connection.", badge: "Subscription", connected: xaiConnected, installed: openCodeInstalled, canConnect: openCodeInstalled, connectionId: xaiConnected ? "local-xai" : null, models: modelsFor("xai", allModels), note: xaiConnected ? "Sign-in found through OpenCode; model access is checked when a task runs." : "Secure device sign-in through OpenCode." },
    { id: "google", name: "Google Gemini", shortName: "Gemini", description: "A free Gemini API key from Google AI Studio — a Google account is enough, no card. Free-tier limits apply.", badge: "Free key", connected: googleConnected, installed: openCodeInstalled, canConnect: false, connectionId: googleConnected ? "local-google" : null, models: modelsFor("google", allModels).filter((model) => !/(?:deep-research|computer-use|tts|embedding|image|live|veo|lyria|omni|gemini-2\.)/.test(model)), note: googleConnected ? "Key saved in OpenCode on this Mac; free-tier limits apply." : "Paste a free key from aistudio.google.com." },
    ...(apple.installed ? [{ id: "apple" as const, name: "Apple Intelligence", shortName: "Apple", description: "Apple's built-in AI on this Mac: free and private, nothing leaves your Mac. It can talk and draft, but can't use mail, files or the web here, so it's used only when nothing else is available.", badge: "Built in", connected: apple.available, installed: true, canConnect: false, connectionId: apple.available ? "local-apple" : null, models: apple.available ? [APPLE_MODEL] : [], note: apple.available ? "Built into this Mac. Free and private, for small jobs." : apple.reason }] : []),
  ];
  const connectionMap = new Map(catalog.map((entry) => [entry.connectionId, entry]));
  const instances = db.listProviders().map((instance) => {
    const entry = connectionMap.get(instance.id);
    const configured = instance.apiConfig ? instance.hasSecret || isLocalModelUrl(instance.apiConfig.baseUrl) : instance.hasSecret && Boolean(legacyApiProviderId(instance.envName));
    // The ChatGPT plan connection works only while its owner is signed in.
    const connected = instance.id === CHATGPT_PLAN_ID ? openCodeInstalled && chatgptPlanSignedIn(db) : instance.authMode === "api_key" ? openCodeInstalled && configured : Boolean(entry?.connected);
    const instanceModels = instance.apiConfig ? configuredModels(instance) : entry?.models || (instance.authMode === "api_key" ? agentModels(apiModels.get(instance.id) || apiKeyModels(instance, allModels)) : modelsFor(instance.provider, allModels));
    const note = entry?.note || (!configured ? "Add an API address and model to finish setup." : !openCodeInstalled ? "Saved. Install OpenCode to run this model." : "Saved, not tested. Model and tool support depend on your provider.");
    return { ...instance, connected, models: instanceModels, defaultModel: preferredModel(instance.provider, instanceModels), note };
  });
  return {
    id: "opencode", name: "Sidemates connections", connected: instances.some((instance) => instance.connected), cliAvailable: openCodeInstalled,
    version: openCodeInstalled ? openCodeVersion.stdout.trim() : null, defaultModel: "", models: allModels,
    note: instances.some((instance) => instance.connected) ? "Model connections found. Availability and account limits are checked when a task runs." : "Connect one model account to wake your teammates.",
    instances, catalog, loginAttempts,
  };
}

export const readProviderStatus = createProviderStatusReader(inspectProviderStatus);

class OpenCodeAuthBridge {
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private starting: Promise<string> | null = null;
  private readonly password = randomUUID();

  private headers() {
    return { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}` };
  }

  async ensure(): Promise<string> {
    if (this.url) return this.url;
    if (this.starting) return this.starting;
    this.starting = new Promise(async (resolve, reject) => {
      const port = await availablePort().catch(reject);
      if (!port) return;
      const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { env: safeHostEnvironment({ OPENCODE_SERVER_PASSWORD: this.password }), stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      let output = "";
      const inspect = (chunk: unknown) => {
        output += stripAnsi(String(chunk));
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match && !this.url) { this.url = match[0]; resolve(this.url); }
      };
      child.stdout?.on("data", inspect); child.stderr?.on("data", inspect);
      child.on("error", reject);
      child.on("close", () => { this.child = null; this.url = null; this.starting = null; });
      setTimeout(() => { if (!this.url) { child.kill("SIGTERM"); reject(new Error("OpenCode sign-in service did not start.")); } }, 8_000);
    });
    try { return await this.starting; } finally { this.starting = null; }
  }

  async authorize(providerId: string): Promise<OAuthAuthorization> {
    const base = await this.ensure();
    const methodsResponse = await fetch(`${base}/provider/auth`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    if (!methodsResponse.ok) throw new Error("Could not read the runtime’s available sign-in methods.");
    const methods = await methodsResponse.json() as Record<string, unknown>;
    const methodIndex = oauthMethodIndex(methods[providerId]);
    const inputs: Record<string, string> = providerId === "github-copilot" ? { deploymentType: "github.com" } : providerId === "gitlab" ? { instanceUrl: "https://gitlab.com" } : {};
    const response = await fetch(`${base}/provider/${encodeURIComponent(providerId)}/oauth/authorize`, { method: "POST", headers: this.headers(), body: JSON.stringify({ method: methodIndex, inputs }), signal: AbortSignal.timeout(30_000) });
    const body = await response.json() as OAuthAuthorization & { data?: { message?: string } };
    if (!response.ok) throw new Error(body.data?.message || `Could not start ${providerId} sign-in.`);
    if (!["auto", "code"].includes(body.method) || typeof body.url !== "string" || new URL(body.url).protocol !== "https:") throw new Error("The runtime returned an unsupported sign-in flow. Sign in through its own app instead.");
    return { ...body, methodIndex };
  }

  async callback(providerId: string, methodIndex: number, code?: string): Promise<void> {
    const base = await this.ensure();
    const response = await fetch(`${base}/provider/${encodeURIComponent(providerId)}/oauth/callback`, { method: "POST", headers: this.headers(), body: JSON.stringify({ method: methodIndex, ...(code ? { code } : {}) }), signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error("The sign-in code was not accepted.");
  }

  /** Saves an API key the owner pasted, through OpenCode's own credential
   * store (the same place its /connect command writes). */
  async setApiKey(providerId: string, key: string): Promise<void> {
    const base = await this.ensure();
    const response = await fetch(`${base}/auth/${encodeURIComponent(providerId)}`, { method: "PUT", headers: this.headers(), body: JSON.stringify({ type: "api", key }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("OpenCode didn't save the key. Try again.");
  }

  stop() { this.child?.kill("SIGTERM"); this.child = null; this.url = null; }
}

export class ProviderConnectionManager {
  private readonly methodIndexes = new Map<string, number>();
  private readonly attempts = new Map<string, ProviderLoginAttempt>();
  private readonly claudeProcesses = new Map<string, ChildProcess>();

  constructor(private readonly onChange: () => void, private readonly bridge: Pick<OpenCodeAuthBridge, "authorize" | "callback" | "stop" | "setApiKey"> = new OpenCodeAuthBridge()) {}

  /** Paste-a-key setup (OpenCode Go). The key goes straight to OpenCode's
   * credential store; Sidemates never keeps or shows it. */
  async saveKey(providerId: "opencode-go" | "google", key: string): Promise<ProviderLoginAttempt> {
    const trimmed = key.trim();
    if (!/^[A-Za-z0-9_\-.]{20,300}$/.test(trimmed)) throw new Error(providerId === "google" ? "That doesn't look like a Gemini API key. Copy it again from aistudio.google.com." : "That doesn't look like an OpenCode key. Copy it again from opencode.ai.");
    await this.bridge.setApiKey(providerId, trimmed);
    const attempt: ProviderLoginAttempt = { id: randomUUID(), providerId: providerId === "google" ? "google" : "opencode", status: "connected", url: null, callbackMode: null, instructions: "Key saved.", error: null };
    this.attempts.set(attempt.id, attempt);
    this.onChange();
    return attempt;
  }

  listAttempts(): ProviderLoginAttempt[] { return [...this.attempts.values()].slice(-6); }

  async connect(providerId: string): Promise<ProviderLoginAttempt> {
    const waiting = [...this.attempts.values()].find((attempt) => attempt.providerId === providerId && attempt.status === "waiting");
    if (waiting) return waiting;
    const id = randomUUID();
    const attempt: ProviderLoginAttempt = { id, providerId, status: "waiting", url: null, callbackMode: null, instructions: "Complete the secure sign-in in your browser.", error: null };
    this.attempts.set(id, attempt);
    if (providerId === "claude") {
      const child = spawn("claude", ["auth", "login", "--claudeai"], { env: safeHostEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      this.claudeProcesses.set(id, child);
      let errorText = "";
      child.stderr?.on("data", (chunk) => (errorText += stripAnsi(String(chunk))));
      child.on("error", (error) => { attempt.status = "failed"; attempt.error = error.message; this.onChange(); });
      child.on("close", (code) => { this.claudeProcesses.delete(id); attempt.status = code === 0 ? "connected" : "failed"; attempt.error = code === 0 ? null : errorText.trim().slice(-800) || "Claude sign-in was not completed."; this.onChange(); });
      this.onChange();
      return attempt;
    }
    try {
      const auth = await this.bridge.authorize(providerId);
      attempt.url = auth.url; attempt.callbackMode = auth.method; attempt.instructions = auth.instructions || attempt.instructions;
      this.methodIndexes.set(id, auth.methodIndex);
      if (auth.method === "auto") {
        // Device/browser flows need the callback to poll/complete too; showing
        // the authorization URL alone leaves them waiting indefinitely.
        void this.bridge.callback(providerId, auth.methodIndex).then(() => {
          attempt.status = "connected"; attempt.error = null; this.onChange();
        }).catch((error) => {
          attempt.status = "failed"; attempt.error = error instanceof Error ? error.message : "Sign-in wasn’t completed."; this.onChange();
        });
      }
    } catch (error) {
      attempt.status = "failed"; attempt.error = error instanceof Error ? error.message : String(error);
    }
    this.onChange();
    return attempt;
  }

  async finish(attemptId: string, code: string) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.status !== "waiting") throw new Error("That sign-in is no longer waiting.");
    if (attempt.callbackMode !== "code") throw new Error("Finish this sign-in in your browser.");
    await this.bridge.callback(attempt.providerId, this.methodIndexes.get(attemptId)!, code);
    attempt.status = "connected"; attempt.error = null; this.onChange();
    return attempt;
  }

  stop() {
    this.bridge.stop();
    for (const child of this.claudeProcesses.values()) child.kill("SIGTERM");
    this.claudeProcesses.clear();
  }
}
