import { z } from "zod";
import type { ApiConnectionConfig, ProviderInstance } from "./types.js";

export const MODEL_KEY_ENV = "OPENBOT_MODEL_API_KEY";
/** Free-tier models repeatedly stall on multi-step agent work in our pilot
 * runs (trivial file tasks left unfinished, review steps skipped), while the
 * same prompts pass on full models. The helper only names the tier so the
 * UI can warn; nothing is blocked and no model is judged beyond the suffix. */
export function isFreeTierModel(model: string): boolean {
  const tail = model.split("/").at(-1) ?? model;
  return tail === "free" || tail.toLowerCase().endsWith("-free");
}
export const isLocalModelUrl = (raw: string): boolean => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(raw).hostname);
  } catch {
    return false;
  }
};

export const apiConnectionSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .max(2048)
    .url()
    .superRefine((value, ctx) => {
      const url = new URL(value);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
          !(url.protocol === "http:" && isLocalModelUrl(value)))
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "Use an HTTPS API address, or HTTP on localhost. Keep keys and query parameters out of the address.",
        });
      }
    })
    .transform((value) => value.replace(/\/+$/, "")),
  protocol: z.enum(["openai-compatible", "openai", "anthropic"]),
  modelIds: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(
          /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/,
          "Use the exact model ID from your provider.",
        ),
    )
    .min(1)
    .max(50)
    .transform((ids) => [...new Set(ids)]),
});

// Legacy native clients may still supply these three key-based presets. Do not
// allow arbitrary process variables (NODE_OPTIONS, PATH, internal tokens, etc.).
export const legacyApiProviderId = (env: string | null): string | null =>
  ({
    OPENAI_API_KEY: "openai",
    ANTHROPIC_API_KEY: "anthropic",
    OPENROUTER_API_KEY: "openrouter",
  })[env || ""] || null;

export const providerInput = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .optional(),
    name: z.string().trim().min(1).max(60),
    provider: z
      .enum([
        "opencode",
        "claude",
        "openai",
        "github-copilot",
        "gitlab",
        "xai",
        "google",
        "apple",
        "custom",
      ])
      .optional(),
    authMode: z.enum(["cli", "subscription", "api_key"]),
    runtime: z.enum(["opencode", "claude_code", "apple_fm"]).optional(),
    envName: z.string().nullable().optional(),
    secret: z.string().trim().max(10_000).nullable().optional(),
    apiConfig: apiConnectionSchema.nullable().optional(),
  })
  .superRefine((input, ctx) => {
    const error = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (input.authMode !== "api_key") return;
    if (input.runtime === "claude_code")
      error("API connections use the OpenCode runtime.");
    if (input.apiConfig) {
      if (
        !input.secret &&
        !input.id &&
        !isLocalModelUrl(input.apiConfig.baseUrl)
      )
        error("Add an API key for this hosted provider.");
    } else if (!legacyApiProviderId(input.envName || null))
      error("Add your provider’s API address and at least one model ID.");
    if (
      input.envName &&
      input.envName !== MODEL_KEY_ENV &&
      !legacyApiProviderId(input.envName)
    )
      error("That environment variable is not an API-key preset.");
  });

export type ProviderInput = z.infer<typeof providerInput>;
export const configuredProviderId = (
  instance: Pick<ProviderInstance, "id">,
): string => `openbot-${instance.id}`;
export function configuredModels(
  instance: Pick<ProviderInstance, "id" | "apiConfig">,
): string[] {
  return (
    instance.apiConfig?.modelIds.map(
      (model) => `${configuredProviderId(instance)}/${model}`,
    ) || []
  );
}

export function modelBelongsToConnection(
  model: string,
  instance: ProviderInstance,
): boolean {
  if (instance.apiConfig) return configuredModels(instance).includes(model);
  if (instance.runtime === "claude_code")
    return /^claude-code\/[a-z0-9][a-z0-9._:\[\]-]{0,199}$/i.test(model);
  // Apple's built-in AI has one model, on this Mac.
  if (instance.runtime === "apple_fm") return model === "apple/on-device";
  if (instance.authMode === "api_key") {
    const prefix = legacyApiProviderId(instance.envName);
    return Boolean(prefix && model.startsWith(`${prefix}/`));
  }
  const prefixes: Record<ProviderInstance["provider"], string[]> = {
    opencode: ["opencode/", "opencode-go/"],
    claude: ["anthropic/"],
    openai: ["openai/"],
    "github-copilot": ["github-copilot/"],
    gitlab: ["gitlab/"],
    xai: ["xai/"],
    google: ["google/"],
    apple: ["apple/"],
    custom: [],
  };
  return prefixes[instance.provider].some((prefix) => model.startsWith(prefix));
}

export function apiRuntimeEnvironment(
  instance: ProviderInstance,
  secret: string | null,
): Record<string, string> {
  if (!instance.apiConfig) {
    return legacyApiProviderId(instance.envName) && secret
      ? { [instance.envName!]: secret }
      : {};
  }
  const config: ApiConnectionConfig = apiConnectionSchema.parse(
    instance.apiConfig,
  );
  const id = configuredProviderId(instance);
  const models = Object.fromEntries(
    config.modelIds.map((model) => [model, { name: model, tool_call: true }]),
  );
  return {
    ...(secret ? { [MODEL_KEY_ENV]: secret } : {}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      enabled_providers: [id],
      provider: {
        [id]: {
          npm: `@ai-sdk/${config.protocol}`,
          name: instance.name,
          options: {
            baseURL: config.baseUrl,
            apiKey: secret ? `{env:${MODEL_KEY_ENV}}` : "local-no-key",
          },
          models,
        },
      },
    }),
  };
}

/** Models known to run Sidemates teammates well, best first. The first one a
 * connection offers is shown first and preselected. Teammates read mail,
 * messages, notes and files, so a model whose provider may train on prompts is
 * never recommended (see mayTrainOnPrompts). DeepSeek V4.1 Flash on OpenCode Go
 * is "Not used" for training with zero retention (opencode.ai/docs/go, 7 Oct
 * 2026) and passed every live prompt-eval case (qa/prompt-eval). */
export const RECOMMENDED_MODELS = ["opencode-go/deepseek-v4.1-flash", "google/gemini-flash-lite-latest"] as const;

/** Shown wherever such a model can be chosen or is in use. */
export const TRAINING_NOTICE = "This provider may use your prompts to train its models.";

/** OpenCode's "Contributor" models are discounted in exchange for letting Meta
 * train on prompts and completions (opencode.ai/docs/go, checked 7 Oct 2026). */
export function mayTrainOnPrompts(model: string): boolean {
  return /^opencode(?:-go)?\/.+-contributor(?:-free)?$/i.test(model);
}

/** OpenCode's free tier only answers requests from OpenCode's own app, so it
 * rejects teammate runs (HTTP 403). Offering it would be a first-run trap. */
export function isBlockedFreeTierModel(model: string): boolean {
  return model.startsWith("opencode/") && isFreeTierModel(model);
}

const MODEL_WORDS: Record<string, string> = { gpt: "GPT", glm: "GLM", ai: "AI", llm: "LLM", vl: "VL", exp: "Experimental", hy: "HY", deepseek: "DeepSeek" };

/** "opencode-go/gpt-5.6-luna" → "GPT 5.6 Luna". */
export function friendlyModelName(model: string): string {
  if (model === "apple/on-device") return "Apple Intelligence";
  const tail = model.split("/").at(-1) || model;
  // The tier is shown separately, so "space-bunny-free" reads "Space Bunny".
  return tail.split(/[-_]/).filter(Boolean).filter((word, index, words) => !(index === words.length - 1 && index > 0 && word.toLowerCase() === "free")).map((word) => {
    const lower = word.toLowerCase();
    if (MODEL_WORDS[lower]) return MODEL_WORDS[lower];
    const acronym = /^([a-z]{1,4})(\d.*)$/i.exec(word);
    if (acronym && MODEL_WORDS[acronym[1]!.toLowerCase()]) return `${MODEL_WORDS[acronym[1]!.toLowerCase()]}${acronym[2]}`;
    return /^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ");
}

export interface ModelChoice { value: string; label: string; detail?: string; disabled?: boolean }

/** Recommended first, usable models next, models that may train on prompts
 * after them, blocked free-tier models last. */
/** The model a connection should start on: a known-good one if it offers one,
 * otherwise the connection's own default, never one that fails or trains on prompts. */
function recommendedModel(models: string[], connectionDefault?: string): string | undefined {
  return RECOMMENDED_MODELS.find((id) => models.includes(id))
    || (connectionDefault && models.includes(connectionDefault) && !isBlockedFreeTierModel(connectionDefault) && !mayTrainOnPrompts(connectionDefault) ? connectionDefault : undefined);
}

export function modelChoices(models: string[], connectionDefault?: string): ModelChoice[] {
  const recommended = recommendedModel(models, connectionDefault);
  const rank = (model: string) => model === recommended ? 0 : isBlockedFreeTierModel(model) ? 3 : mayTrainOnPrompts(model) ? 2 : 1;
  return [...models].sort((a, b) => rank(a) - rank(b)).map((model) => ({
    value: model,
    label: friendlyModelName(model),
    detail: model === recommended ? "Recommended" : isBlockedFreeTierModel(model) ? "Free tier · works only inside OpenCode's own app" : mayTrainOnPrompts(model) ? "May train on your prompts" : isFreeTierModel(model) ? "Free tier" : model.split("/")[0] === "opencode-go" ? "OpenCode Go" : undefined,
    disabled: isBlockedFreeTierModel(model) || undefined,
  }));
}

export function defaultModelChoice(models: string[], connectionDefault?: string): string {
  return recommendedModel(models, connectionDefault) || "";
}
