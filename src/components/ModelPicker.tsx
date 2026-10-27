import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, LoaderCircle, Sparkles } from "lucide-react";
import { ProviderIcon } from "../ProviderIcon";
import {
  defaultModelChoice,
  friendlyModelName,
  isBlockedFreeTierModel,
  isFreeTierModel,
  mayTrainOnPrompts,
} from "../shared/provider-config";
import type { Bot, ProviderInstance, ProviderStatus } from "../shared/types";
import "./model-picker.css";

/** Which AI a teammate uses, as one small selector: the chip shows the model
 * in plain words, the menu lists Automatic and every connected model. The same
 * control sits in the message box and in Your AI settings. */

let cached: { at: number; status: ProviderStatus } | null = null;
export function useProviderStatus(refreshKey = 0) {
  const [status, setStatus] = useState<ProviderStatus | null>(cached?.status ?? null);
  useEffect(() => {
    if (cached && Date.now() - cached.at < 15_000 && refreshKey === 0) return;
    const abort = new AbortController();
    fetch("/api/provider", { credentials: "same-origin", signal: abort.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((next: ProviderStatus | null) => { if (next) { cached = { at: Date.now(), status: next }; setStatus(next); } })
      .catch(() => {});
    return () => abort.abort();
  }, [refreshKey]);
  return status;
}

const iconFor = (instance?: ProviderInstance) => instance?.provider === "apple" ? "opencode" : instance?.provider === "google" ? "opencode" : instance?.provider || "opencode";

function modelTag(instance: ProviderInstance, model: string): string {
  if (isBlockedFreeTierModel(model)) return "Works only inside OpenCode";
  if (mayTrainOnPrompts(model)) return "May train on your prompts";
  if (isFreeTierModel(model)) return "Free tier";
  if (model === defaultModelChoice(instance.models || [])) return "Recommended";
  return "";
}

export function ModelPicker({
  bot,
  provider,
  save,
  direction = "down",
  variant = "chip",
}: {
  bot: Bot;
  provider: ProviderStatus | null;
  save: (patch: Partial<Bot>) => Promise<void>;
  direction?: "up" | "down";
  variant?: "chip" | "field";
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); root.current?.querySelector<HTMLButtonElement>(".model-picker-trigger")?.focus(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); };
  }, [open]);

  const automatic = bot.aiMode === "automatic";
  const current = provider?.instances.find((entry) => entry.id === bot.providerInstanceId);
  const label = bot.model ? friendlyModelName(bot.model) : "Choose an AI";
  // The provider in use comes first, and long catalogs fold after a few models.
  const ready = (provider?.instances || [])
    .filter((entry) => entry.connected && entry.models?.length)
    .sort((a, b) => Number(b.id === bot.providerInstanceId) - Number(a.id === bot.providerInstanceId));
  const FOLD = 6;
  const choose = async (patch: Partial<Bot>) => {
    setBusy(true); setError("");
    try { await save(patch); setOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "That didn’t work. Try again."); }
    finally { setBusy(false); }
  };

  const trigger: ReactNode = (
    <button
      type="button"
      className="model-picker-trigger"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={`${bot.name}’s AI: ${automatic ? "Automatic, " : ""}${label}. Change`}
      onClick={() => setOpen((value) => !value)}
    >
      {automatic ? <Sparkles size={14} aria-hidden="true" /> : <ProviderIcon id={iconFor(current)} className="model-picker-icon" />}
      <span>{automatic ? (bot.model ? `Auto · ${label}` : "Auto") : label}</span>
      <ChevronDown size={13} aria-hidden="true" />
    </button>
  );

  return (
    <div className={`model-picker ${variant} ${direction}`} ref={root}>
      {trigger}
      {open && (
        <div className="model-picker-menu" role="listbox" aria-label={`AI for ${bot.name}`}>
          <button type="button" role="option" aria-selected={automatic} className="model-picker-option" disabled={busy} onClick={() => void choose({ aiMode: "automatic" })}>
            <Sparkles size={16} aria-hidden="true" />
            <span><strong>Automatic</strong><small>The best AI you have for each job</small></span>
            {automatic && <Check size={15} aria-hidden="true" />}
          </button>
          {ready.length === 0 && (
            <p className="model-picker-empty">No AI is connected yet. <a href="/?panel=provider">Connect one</a> to choose a model.</p>
          )}
          {ready.map((instance) => (
            <div key={instance.id} role="group" aria-label={instance.name}>
              <div className="model-picker-group"><ProviderIcon id={iconFor(instance)} className="model-picker-icon" />{instance.name}</div>
              {(() => {
                const all = instance.models!;
                const open = expanded.includes(instance.id);
                const recommended = defaultModelChoice(all);
                // Keep the chosen and recommended models visible when folded.
                const shown = open || all.length <= FOLD + 1
                  ? all
                  : [...new Set([...all.slice(0, FOLD), ...(instance.id === bot.providerInstanceId && bot.model && all.includes(bot.model) ? [bot.model] : []), ...(recommended ? [recommended] : [])])];
                return shown;
              })().map((model) => {
                const selected = !automatic && bot.providerInstanceId === instance.id && bot.model === model;
                const blocked = isBlockedFreeTierModel(model) && !selected;
                const tag = modelTag(instance, model);
                return (
                  <button
                    key={model}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className="model-picker-option"
                    disabled={busy || blocked}
                    onClick={() => void choose({ providerInstanceId: instance.id, model, aiMode: "chosen" })}
                  >
                    <span className="model-picker-indent" aria-hidden="true" />
                    <span><strong>{friendlyModelName(model)}</strong>{tag && <small>{tag}</small>}</span>
                    {busy && selected ? <LoaderCircle size={14} className="spin" /> : selected ? <Check size={15} aria-hidden="true" /> : null}
                  </button>
                );
              })}
              {instance.models!.length > FOLD + 1 && (
                <button type="button" className="model-picker-more" onClick={() => setExpanded((value) => value.includes(instance.id) ? value.filter((id) => id !== instance.id) : [...value, instance.id])}>
                  {expanded.includes(instance.id) ? "Show fewer" : `Show all ${instance.models!.length}`}
                </button>
              )}
            </div>
          ))}
          {error && <p className="model-picker-error" role="alert">{error}</p>}
          <a className="model-picker-manage" href="/?panel=provider">Manage connections</a>
        </div>
      )}
    </div>
  );
}
