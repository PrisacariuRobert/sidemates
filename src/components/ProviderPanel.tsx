import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Plus,
} from "lucide-react";
import { SettingsCard, SettingsGroup, SettingsRow, SegmentedControl } from "../studio/Settings";
import { ProviderIcon } from "../ProviderIcon";
import {
  isFreeTierModel,
  isBlockedFreeTierModel,
  defaultModelChoice,
  mayTrainOnPrompts,
  modelChoices,
  TRAINING_NOTICE,
  isLocalModelUrl,
  providerInput,
  type ProviderInput,
} from "../shared/provider-config";
import type {
  ApiConnectionConfig,
  Bot,
  ProviderCatalogEntry,
  ProviderConnectionTest,
  ProviderLoginAttempt,
  ProviderStatus,
} from "../shared/types";
import "./provider-panel.css";
import { BringYourAI, KeyPaste } from "./BringYourAI";

type Props = {
  provider: ProviderStatus | null;
  bots: Bot[];
  onUpdateBot: (id: string, patch: Partial<Bot>) => Promise<void>;
  onChooseInitial: (providerInstanceId: string, model: string) => Promise<void>;
  onAdd: (input: ProviderInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onConnect: (id: ProviderCatalogEntry["id"]) => Promise<ProviderLoginAttempt>;
  onFinish: (id: string, code: string) => Promise<void>;
  connectionTests: Record<string, ProviderConnectionTest>;
  onTestConnection: (id: string) => Promise<ProviderConnectionTest>;
  mascot: (bot: Bot) => ReactNode;
  modelLabel: (model: string) => string;
};

const presets: Record<
  string,
  { name: string; baseUrl: string; protocol: ApiConnectionConfig["protocol"] }
> = {
  openai: {
    name: "OpenAI API",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai",
  },
  anthropic: {
    name: "Anthropic API",
    baseUrl: "https://api.anthropic.com/v1",
    protocol: "anthropic",
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "openai-compatible",
  },
  ollama: {
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    protocol: "openai-compatible",
  },
  lmstudio: {
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    protocol: "openai-compatible",
  },
  custom: {
    name: "My model server",
    baseUrl: "",
    protocol: "openai-compatible",
  },
};

/** The one-minute path for most people: a $10/month key, pasted once. */
export function RecommendedAI({ onConnected, compact = false }: { onConnected: (connectionId: string) => Promise<void>; compact?: boolean }) {
  const [key, setKey] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/provider/key", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: "opencode-go", key }) });
      const result = await response.json().catch(() => ({})) as { error?: string; connectionId?: string };
      if (!response.ok || !result.connectionId) throw new Error(result.error || "The key wasn't accepted.");
      setKey("");
      await onConnected(result.connectionId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The key wasn't accepted."); }
    finally { setBusy(false); }
  };
  return (
    <section className={`ai-recommended${compact ? " is-compact" : ""}`} aria-labelledby="ai-recommended-title">
      <span className="ai-recommended-badge">Recommended</span>
      <h3 id="ai-recommended-title">OpenCode Go</h3>
      <p>One subscription for your whole team — about $10 a month, with fast, capable models. Set up once, in about a minute.</p>
      <ol>
        <li>
          <span>1</span>
          <div><strong>Get your key</strong><small>Subscribe to Go, then copy your API key.</small></div>
          <a className="ai-recommended-link" href="https://opencode.ai/go" target="_blank" rel="noreferrer">Open opencode.ai <ExternalLink size={14} /></a>
        </li>
        <li>
          <span>2</span>
          <div><strong>Paste it here</strong><small>It goes straight to OpenCode on this Mac. Sidemates never shows it again.</small></div>
        </li>
      </ol>
      <form onSubmit={(event) => void submit(event)}>
        <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder="Paste your OpenCode Go key" aria-label="OpenCode Go key" />
        <button type="submit" className="button-primary" disabled={busy || key.trim().length < 20}>{busy ? <LoaderCircle size={15} className="spinner" /> : null}Connect</button>
      </form>
      {error && <p className="ai-recommended-error" role="alert">{error}</p>}
    </section>
  );
}

export function ProviderPanel({
  provider,
  bots,
  onUpdateBot,
  onChooseInitial,
  onAdd,
  onDelete,
  onConnect,
  onFinish,
  connectionTests,
  onTestConnection,
  mascot,
  modelLabel,
}: Props) {
  const [mode, setMode] = useState<"accounts" | "api">("accounts");
  const [selectedAccount, setSelectedAccount] = useState("");
  const [adding, setAdding] = useState(false);
  const [preset, setPreset] = useState("openai");
  const [name, setName] = useState(presets.openai!.name);
  const [baseUrl, setBaseUrl] = useState(presets.openai!.baseUrl);
  const [protocol, setProtocol] =
    useState<ApiConnectionConfig["protocol"]>("openai");
  const [modelIds, setModelIds] = useState("");
  const [secret, setSecret] = useState("");
  const [attempt, setAttempt] = useState<ProviderLoginAttempt | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [initialConnection, setInitialConnection] = useState("");
  const [initialModel, setInitialModel] = useState("");
  const [pendingConnections, setPendingConnections] = useState<Record<string, string>>({});
  const needsChoice = bots.some((bot) => !bot.providerInstanceId && !bot.model);
  const openCodeEntry = provider?.catalog.find((entry) => entry.id === "opencode");
  // A saved key that failed its test still needs the simple path: paste again.
  const openCodeConnected = Boolean(openCodeEntry?.connected) && connectionTests[openCodeEntry?.connectionId || "local-opencode"]?.ok !== false;
  const initial = provider?.instances.find((entry) => entry.id === initialConnection);
  // Polling refreshes the shared status. Never keep showing an old waiting
  // attempt after the runtime has reported success or failure.
  const currentAttempt =
    provider?.loginAttempts.find((entry) => entry.id === attempt?.id) ||
    attempt;
  const signedIn = provider?.catalog.some(
    (entry) => entry.id === currentAttempt?.providerId && entry.connected,
  );
  const savedApis =
    provider?.instances.filter((entry) => entry.authMode === "api_key") || [];
  const hasLocalModel = savedApis.some((entry) => entry.apiConfig && isLocalModelUrl(entry.apiConfig.baseUrl));
  const act = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "That didn’t work. Please try again.",
      );
    } finally {
      setBusy(null);
    }
  };
  const choosePreset = (value: string) => {
    const next = presets[value]!;
    setPreset(value);
    setName(next.name);
    setBaseUrl(next.baseUrl);
    setProtocol(next.protocol);
    setSecret("");
    setModelIds("");
  };
  const testTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch { return ""; }
  };
  // Only a live reply counts as tested. Saved sign-ins and keys stay "Saved,
  // not tested" until the owner runs the tiny probe (uses a little allowance).
  const connectionTest = (connectionId: string | null, actionKey: string) => {
    if (!connectionId) return null;
    const receipt = connectionTests[connectionId];
    return (
      <div className="ai-test">
        <span className="ai-test-state" title={receipt?.error || undefined}>
          {receipt
            ? receipt.ok
              ? `Tested · ${modelLabel(receipt.model)} · ${testTime(receipt.testedAt)}`
              : `Last test failed · ${testTime(receipt.testedAt)}`
            : "Saved, not tested"}
        </span>
        <button
          type="button"
          className="ai-action"
          disabled={busy !== null}
          onClick={() => void act(actionKey, async () => {
            const receipt = await onTestConnection(connectionId);
            if (!receipt.ok && receipt.error) setError(receipt.error);
          })}
        >
          {busy === actionKey ? (
            <LoaderCircle size={15} className="spinner" />
          ) : receipt ? (
            "Test again"
          ) : (
            "Test connection"
          )}
        </button>
      </div>
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void act("save", async () => {
      const parsed = providerInput.safeParse({
        name,
        provider: "custom",
        authMode: "api_key",
        runtime: "opencode",
        secret,
        apiConfig: {
          baseUrl,
          protocol,
          modelIds: modelIds
            .split(/[\n,]/)
            .map((id) => id.trim())
            .filter(Boolean),
        },
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues[0]?.message || "Check your connection details.",
        );
      await onAdd(parsed.data);
      setSecret("");
      setAdding(false);
      setNotice(
        "Connection saved. Choose it for a teammate below. It hasn’t been tested yet.",
      );
    });
  };
  const accountRow = (entry: ProviderCatalogEntry) => {
    const receipt = entry.connectionId ? connectionTests[entry.connectionId] : null;
    return (
      <SettingsRow
        key={entry.id}
        title={entry.name}
        description={
          <>
            <span>
              {entry.connected
                ? "Sign-in found on this host"
                : entry.installed
                  ? entry.badge
                  : "Runtime not found on this host"}
            </span>
            <details className="about-connection">
              <summary>
                <ChevronRight size={13} className="about-chevron" />
                About this connection
              </summary>
              <p>
                {entry.description} {entry.note}
              </p>
            </details>
          </>
        }
        control={
          entry.connected ? (
            <div className="ai-side">
              <div className="ai-status-stack">
                <span className="ai-signed-in">
                  <Check size={13} /> Signed in
                </span>
                {entry.connectionId && (
                  <span className="ai-test-state" title={receipt?.error || undefined}>
                    {receipt
                      ? receipt.ok
                        ? `Tested · ${modelLabel(receipt.model)} · ${testTime(receipt.testedAt)}`
                        : `Last test failed · ${testTime(receipt.testedAt)}`
                      : "Saved, not tested"}
                  </span>
                )}
              </div>
              {entry.connectionId && (
                <button
                  type="button"
                  className="ai-action"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`test-${entry.id}`, async () => {
                      const r = await onTestConnection(entry.connectionId!);
                      if (!r.ok && r.error) setError(r.error);
                    })
                  }
                >
                  {busy === `test-${entry.id}` ? (
                    <LoaderCircle size={14} className="spinner" />
                  ) : receipt ? (
                    "Test again"
                  ) : (
                    "Test connection"
                  )}
                </button>
              )}
            </div>
          ) : entry.canConnect ? (
            <button
              type="button"
              className="ai-action"
              disabled={busy !== null}
              onClick={() =>
                void act(entry.id, async () => {
                  const next = await onConnect(entry.id);
                  setAttempt(next);
                  if (next.url)
                    window.open(next.url, "_blank", "noopener,noreferrer");
                })
              }
            >
              {busy === entry.id ? (
                <LoaderCircle size={14} className="spinner" />
              ) : (
                "Connect"
              )}
            </button>
          ) : entry.id === "google" && entry.installed ? (
            <KeyPaste providerId="google" link="https://aistudio.google.com/apikey" linkLabel="Get a free key" placeholder="Paste your Gemini API key" onSaved={afterConnect} />
          ) : (
            <span className="ai-state">
              {entry.id === "opencode" && entry.installed ? "Paste a key above" : entry.installed ? "Set up in OpenCode" : "Setup needed"}
            </span>
          )
        }
      />
    );
  };
  const afterConnect = async (connectionId: string) => {
    setNotice("Connected. Checking it with a short test…");
    const result = await onTestConnection(connectionId).catch(() => null);
    if (result?.ok) setNotice("Connected and working. Choose it when you create a teammate.");
    else { setNotice(null); setError(result?.error ? `Connected, but the test didn't pass: ${result.error}` : "Connected. The first test didn't finish; try “Test connection” below in a moment."); }
  };
  // One list of every sign-in on the left, the chosen one on the right: its
  // status, test, models and which teammates use it.
  const accounts = provider?.catalog || [];
  const versionNumber = /\d+(?:\.\d+)+/.exec(provider?.version || "")?.[0] || "";
  const selected = accounts.find((entry) => entry.id === selectedAccount) || accounts.find((entry) => entry.connected) || accounts[0];
  const accountStatus = (entry: ProviderCatalogEntry) => (entry.connected ? "Signed in" : entry.installed ? "Not signed in" : "Not set up");
  const usedBy = (entry: ProviderCatalogEntry) =>
    bots.filter((bot) => (entry.connectionId && bot.providerInstanceId === entry.connectionId) || (!bot.providerInstanceId && bot.model && entry.models.includes(bot.model)));
  const accountBrowser = accounts.length > 0 && selected && (
    <div className="provider-split">
      <ul className="provider-list" aria-label="Providers">
        {accounts.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className={`provider-item${entry.id === selected.id ? " selected" : ""}`}
              aria-current={entry.id === selected.id ? "true" : undefined}
              onClick={() => setSelectedAccount(entry.id)}
            >
              <ProviderIcon id={entry.id} className="provider-item-icon" />
              <span className="provider-item-copy">
                <strong>{entry.shortName || entry.name}{entry.id === "opencode" && versionNumber ? <code>v{versionNumber}</code> : null}</strong>
                <small>{accountStatus(entry)}</small>
              </span>
              <i className={`provider-dot${entry.connected ? " on" : ""}`} role="img" aria-label={entry.connected ? "Connected" : "Not connected"} />
            </button>
          </li>
        ))}
      </ul>
      <section className="provider-detail" aria-label={`${selected.name} details`}>
        <header className="provider-detail-head">
          <ProviderIcon id={selected.id} className="provider-detail-icon" />
          <h4>{selected.name}</h4>
          {selected.id === "opencode" && versionNumber && <code>v{versionNumber}</code>}
        </header>
        <SettingsCard>{accountRow(selected)}</SettingsCard>
        {selected.models.length > 0 && (
          <div className="provider-models">
            <h5>Models</h5>
            <ul>
              {selected.models.slice(0, 24).map((model) => {
                const inUse = usedBy(selected).some((bot) => bot.model === model);
                return <li key={model} className={inUse ? "in-use" : undefined} title={model}>{modelLabel(model)}{inUse && <small>In use</small>}</li>;
              })}
            </ul>
            {selected.models.length > 24 && <p className="ai-help">And {selected.models.length - 24} more.</p>}
          </div>
        )}
        {usedBy(selected).length > 0 && (
          <div className="provider-users">
            <h5>Teammates using it</h5>
            <ul>
              {usedBy(selected).map((bot) => (
                <li key={bot.id}>
                  <span className="provider-user-face">{mascot(bot)}</span>
                  <span><strong>{bot.name}</strong><small>{bot.aiMode === "automatic" ? "Automatic · " : ""}{bot.model ? modelLabel(bot.model) : "No model chosen"}</small></span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
  return (
    <div className="provider-settings">
      {provider && !provider.instances.some((entry) => entry.connected && connectionTests[entry.id]?.ok !== false) && <BringYourAI onConnected={afterConnect} />}
      {(!provider || provider.instances.some((entry) => entry.connected && connectionTests[entry.id]?.ok !== false)) && <header className="ai-intro" style={bots[0] ? { "--mascot-color": bots[0].color } as CSSProperties : undefined}>
        <div>
          <h3>Your AI, your choice.</h3>
          <p>
            Choose an account or local model for each teammate. Nothing switches
            until you choose the model too.
          </p>
        </div>
        {bots[0] && (
          <div className="ai-intro-mascot" aria-hidden="true">
            {mascot(bots[0])}
          </div>
        )}
      </header>}
      {!provider && <p role="status">Checking your connections…</p>}
      {needsChoice && (
        <SettingsGroup title="First, choose the AI you want to use">
          <p>No provider is selected for you. Connect an account below, or choose an existing connection. You can mix models later.</p>
          <SettingsCard>
            <SettingsRow
              title="Provider"
              control={
                <select aria-label="First provider" value={initialConnection} onChange={(event) => { setInitialConnection(event.target.value); setInitialModel(""); }} disabled={busy !== null}>
                  <option value="">Choose your provider</option>
                  {provider?.instances.filter((entry) => entry.connected && entry.models?.length).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select>
              }
            />
            <SettingsRow
              title="Model"
              control={
                <select aria-label="First model" value={initialModel} onChange={(event) => setInitialModel(event.target.value)} disabled={!initial || busy !== null}>
                  <option value="">Choose a model</option>
                  {modelChoices(initial?.models || []).map((choice) => <option key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.label}{choice.detail ? ` · ${choice.detail}` : ""}</option>)}
                </select>
              }
            >
              {isFreeTierModel(initialModel) && (
                <p className="settings-row-note">Free-tier access may not allow Sidemates teammate runs. A connection test only proves a short reply; try a real task before relying on this model.</p>
              )}
              {mayTrainOnPrompts(initialModel) && (
                <p className="settings-row-note">{TRAINING_NOTICE} Choose another model for teammates that read your mail, messages or files.</p>
              )}
            </SettingsRow>
            <SettingsRow
              title="Unconfigured teammates"
              description="Uses your account’s limits or API billing. Sidemates will not silently switch providers. The first task checks actual model access."
              control={
                <button className="button-primary" disabled={busy !== null || !initial?.connected || !initial?.models?.includes(initialModel)} onClick={() => void act("initial", () => onChooseInitial(initialConnection, initialModel))}>
                  Use this AI for unconfigured teammates
                </button>
              }
            />
          </SettingsCard>
        </SettingsGroup>
      )}
      {error && (
        <div className="ai-feedback ai-error" role="alert">
          <CircleAlert size={17} />
          <p>{error}</p>
        </div>
      )}
      {notice && (
        <div className="ai-feedback" role="status">
          <Check size={17} />
          <p>{notice}</p>
        </div>
      )}
      {!hasLocalModel && mode === "api" && (
        <div className="ai-local-path">
          <div>
            <strong>Local model, if you want one</strong>
            <p>Ollama can run a downloaded model without an API bill. Keep Ollama running here, then choose its exact model name. Speed and tool support depend on the model and this Mac.</p>
          </div>
          <button type="button" onClick={() => {
            choosePreset("ollama"); setAdding(true); setMode("api");
            requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.provider-settings textarea[aria-label="Model IDs"]')?.focus());
          }}>
            Set up Ollama <ChevronRight size={15} />
          </button>
        </div>
      )}
      <div className="provider-mode-wrapper">
        <SegmentedControl
          ariaLabel="Connection type"
          value={mode}
          onChange={(val) => setMode(val as "accounts" | "api")}
          options={[
            { value: "accounts", label: "Accounts & Sign-in" },
            { value: "api", label: "API Keys & Local Models" },
          ]}
        />
      </div>
      {mode === "accounts" ? (
        <SettingsGroup title="Accounts & subscriptions">
          {accountBrowser}
          <p className="ai-help">
            Sign-in uses the installed provider runtime. A saved sign-in doesn’t
            guarantee model access; plan eligibility, provider rules, and usage
            limits still apply.
          </p>
          {currentAttempt &&
            !signedIn &&
            currentAttempt.status !== "connected" && (
              <div
                className="ai-login"
                role={currentAttempt.status === "failed" ? "alert" : "status"}
              >
                <strong>
                  {currentAttempt.status === "failed"
                    ? "Sign-in wasn’t completed"
                    : "Finish signing in"}
                </strong>
                <p>{currentAttempt.error || currentAttempt.instructions}</p>
                {currentAttempt.url && (
                  <a
                    href={currentAttempt.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open sign-in page <ChevronRight size={13} />
                  </a>
                )}
                {currentAttempt.status === "waiting" &&
                  currentAttempt.callbackMode === "code" && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void act("code", async () => {
                          await onFinish(currentAttempt.id, code);
                          setCode("");
                        });
                      }}
                    >
                      <label>
                        Sign-in code
                        <input
                          value={code}
                          onChange={(event) => setCode(event.target.value)}
                          autoComplete="off"
                          required
                        />
                      </label>
                      <button className="ai-action" disabled={busy !== null}>
                        Finish
                      </button>
                    </form>
                  )}
              </div>
            )}
        </SettingsGroup>
      ) : (
        <SettingsGroup title="API & local models">
          {savedApis.length === 0 && (
            <p className="capability-notice">No API or local connections yet. Add one to use a hosted key or a model on your own machine — teammates keep working on their current connections either way.</p>
          )}
          {savedApis.length > 0 && (
            <SettingsCard>
              {savedApis.map((entry) => (
                <SettingsRow
                  key={entry.id}
                  title={entry.name}
                  description={
                    <>
                      <span>{entry.apiConfig?.baseUrl || "API-key connection"}</span>
                      {!connectionTests[entry.id] && <span>{entry.note}</span>}
                    </>
                  }
                  control={
                    <div className="ai-side">
                      <span className="ai-state">Saved</span>
                      {connectionTest(entry.id, `test-${entry.id}`)}
                      <button
                        type="button"
                        className="ai-action"
                        disabled={busy !== null}
                        aria-label={`Remove ${entry.name}`}
                        title="Remove this connection"
                        onClick={() => {
                          if (!window.confirm(`Remove “${entry.name}”? Teammates using it must switch connections first; saved keys are deleted.`)) return;
                          void act(`delete-${entry.id}`, () => onDelete(entry.id));
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  }
                />
              ))}
            </SettingsCard>
          )}
          {!adding ? (
            <button
              type="button"
              className="ai-add"
              onClick={() => {
                setAdding(true);
                setError(null);
              }}
            >
              <Plus size={17} /> Add API or local model
            </button>
          ) : (
            <form onSubmit={submit} style={{ display: "grid", gap: 16 }}>
              <h4>Add a model connection</h4>
              <SettingsCard>
                <SettingsRow
                  title="Provider"
                  control={
                    <select
                      aria-label="Provider"
                      value={preset}
                      onChange={(event) => choosePreset(event.target.value)}
                    >
                      {Object.entries(presets).map(([id, value]) => (
                        <option key={id} value={id}>
                          {id === "custom"
                            ? "Other compatible provider"
                            : value.name}
                        </option>
                      ))}
                    </select>
                  }
                />
                <SettingsRow
                  title="Connection name"
                  control={
                    <input
                      aria-label="Connection name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                      maxLength={60}
                    />
                  }
                />
                <SettingsRow
                  title="API address"
                  description={
                    isLocalModelUrl(baseUrl)
                      ? "Localhost means the computer running Sidemates, not your phone. Start your model server there first."
                      : "Use the API address supplied by your provider, not its chat website."
                  }
                  control={
                    <input
                      aria-label="API address"
                      type="url"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder="https://your-provider.com/v1"
                      spellCheck={false}
                      required
                    />
                  }
                />
                <SettingsRow
                  title="Model IDs"
                  description="Choose models that support tool use for agent work. Names and compatibility come from your provider."
                  control={
                    <textarea
                      aria-label="Model IDs"
                      value={modelIds}
                      onChange={(event) => setModelIds(event.target.value)}
                      placeholder={
                        isLocalModelUrl(baseUrl)
                          ? "e.g. qwen3:8b"
                          : "Paste exact IDs from your provider, one per line"
                      }
                      rows={2}
                      spellCheck={false}
                      required
                    />
                  }
                />
                <SettingsRow
                  title={isLocalModelUrl(baseUrl) ? "API key (optional)" : "API key"}
                  control={
                    <input
                      aria-label="API key"
                      type="password"
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      autoComplete="new-password"
                      required={!isLocalModelUrl(baseUrl)}
                    />
                  }
                />
              </SettingsCard>
              <details className="ai-advanced">
                <summary>Advanced connection options</summary>
                <label>
                  API format
                  <select
                    value={protocol}
                    onChange={(event) =>
                      setProtocol(
                        event.target.value as ApiConnectionConfig["protocol"],
                      )
                    }
                  >
                    <option value="openai-compatible">
                      OpenAI-compatible Chat Completions
                    </option>
                    <option value="openai">OpenAI Responses</option>
                    <option value="anthropic">Anthropic Messages</option>
                  </select>
                </label>
              </details>
              <p className="ai-help ai-key-note">
                <KeyRound size={14} /> Keys are encrypted in Sidemates’s local
                data. Saving won’t send a test request or charge your account.
              </p>
              <div className="ai-form-actions">
                <button
                  type="button"
                  className="ai-action"
                  onClick={() => {
                    setAdding(false);
                    setSecret("");
                  }}
                  disabled={busy !== null}
                >
                  Cancel
                </button>
                <button
                  className="ai-action ai-primary"
                  disabled={busy !== null}
                >
                  {busy === "save" ? "Saving…" : "Save connection"}
                </button>
              </div>
            </form>
          )}
        </SettingsGroup>
      )}
      <SettingsGroup title="Choose for each teammate">
        <p>Mix subscriptions and models to suit the work. Your current choice stays active until you select a different model.</p>
        <SettingsCard>
          {bots.map((bot) => {
            const automatic = bot.aiMode === "automatic";
            const selectedConnectionId = pendingConnections[bot.id] ?? (automatic ? "automatic" : bot.providerInstanceId ?? "");
            const changingConnection = selectedConnectionId !== (automatic ? "automatic" : bot.providerInstanceId ?? "");
            const connection = provider?.instances.find(
              (entry) => entry.id === selectedConnectionId,
            );
            const models = [
              ...new Set([...(changingConnection ? [] : [bot.model]), ...(connection?.models || [])].filter(Boolean)),
            ];
            return (
              <div key={bot.id} className="ai-teammate">
                <div className="ai-teammate-title">
                  {mascot(bot)}
                  <strong>{bot.name}</strong>
                  <span>{bot.role}</span>
                </div>
                <SettingsRow
                  title="Connection"
                  control={
                    <select
                      aria-label={`${bot.name} connection`}
                      value={selectedConnectionId}
                      disabled={busy !== null || !provider}
                      onChange={(event) => {
                        const value = event.target.value;
                        // Automatic needs no model: Sidemates picks one before each job.
                        if (value === "automatic") {
                          void act(bot.id, async () => {
                            await onUpdateBot(bot.id, { aiMode: "automatic" });
                            setPendingConnections((previous) => { const next = { ...previous }; delete next[bot.id]; return next; });
                          });
                          return;
                        }
                        setPendingConnections((previous) => ({ ...previous, [bot.id]: value }));
                      }}
                    >
                      {!connection && selectedConnectionId !== "automatic" && (
                        <option value="">Choose a connection</option>
                      )}
                      <option value="automatic">Automatic · the best AI you have for each job</option>
                      {provider?.instances.map((entry) => (
                        <option
                          key={entry.id}
                          value={entry.id}
                          disabled={!entry.connected || !entry.models?.length}
                        >
                          {entry.name}
                          {!entry.connected ? " · setup needed" : ""}
                        </option>
                      ))}
                    </select>
                  }
                >
                  {changingConnection && <p className="settings-row-note">Choose a model below to switch {bot.name}. Their current connection is still active.</p>}
                  {automatic && !changingConnection && <p className="settings-row-note">Sidemates picks the best AI you've connected for each job{bot.model ? `, now ${modelLabel(bot.model)}` : ""}, and switches if one runs out.</p>}
                </SettingsRow>
                <SettingsRow
                  title="Model"
                  control={
                    <select
                      aria-label={`${bot.name} model`}
                      value={changingConnection ? "" : bot.model}
                      disabled={busy !== null || !connection?.connected || (automatic && !changingConnection)}
                      onChange={(event) => {
                        const model = event.target.value;
                        if (!model) return;
                        void act(bot.id, async () => {
                          await onUpdateBot(bot.id, { providerInstanceId: selectedConnectionId, model, aiMode: "chosen" });
                          setPendingConnections((previous) => {
                            const next = { ...previous };
                            delete next[bot.id];
                            return next;
                          });
                        });
                      }}
                    >
                      {(changingConnection || !bot.model) && <option value="">Choose a model</option>}
                      {models.map((model) => (
                        <option key={model} value={model} disabled={isBlockedFreeTierModel(model) && model !== bot.model}>
                          {modelLabel(model)}
                          {connection?.models?.includes(model)
                            ? isBlockedFreeTierModel(model) ? " · works only inside OpenCode" : mayTrainOnPrompts(model) ? " · may train on your prompts" : isFreeTierModel(model) ? " · Free tier" : model === defaultModelChoice(connection.models || []) ? " · Recommended" : ""
                            : " · unavailable"}
                        </option>
                      ))}
                    </select>
                  }
                >
                  {isBlockedFreeTierModel(bot.model) ? (
                    <p className="settings-row-note">{bot.name} can't work on this model: OpenCode's free tier only answers inside OpenCode's own app. Choose another model.</p>
                  ) : mayTrainOnPrompts(bot.model) ? (
                    <p className="settings-row-note">{TRAINING_NOTICE} Choose another model if {bot.name} reads your mail, messages or files.</p>
                  ) : isFreeTierModel(bot.model) && (
                    <p className="settings-row-note">Free-tier access may not allow Sidemates teammate runs. A connection test only proves a short reply; try a real task before relying on this model.</p>
                  )}
                </SettingsRow>
              </div>
            );
          })}
        </SettingsCard>
      </SettingsGroup>
      <p className="ai-footnote">
        OpenCode {provider?.version || "not detected"} · Connections belong to
        this Sidemates host.
      </p>
    </div>
  );
}
