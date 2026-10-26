import test from "node:test";
import assert from "node:assert/strict";
import {
  apiConnectionSchema,
  apiRuntimeEnvironment,
  configuredModels,
  isFreeTierModel,
  modelBelongsToConnection,
  providerInput,
} from "./provider-config.js";
import type { ProviderInstance } from "./types.js";

const connection: ProviderInstance = {
  id: "test-provider",
  ownerId: "owner",
  name: "Local models",
  provider: "custom",
  authMode: "api_key",
  runtime: "opencode",
  envName: null,
  hasSecret: false,
  createdAt: "",
  updatedAt: "",
  apiConfig: {
    baseUrl: "http://127.0.0.1:11434/v1",
    protocol: "openai-compatible",
    modelIds: ["qwen3:8b", "org/my-model"],
  },
};

test("custom connections require an endpoint and model; only loopback can omit HTTPS and a key", () => {
  assert.equal(
    providerInput.safeParse({
      name: "Incomplete",
      authMode: "api_key",
      envName: "PROVIDER_API_KEY",
      secret: "key",
    }).success,
    false,
  );
  const local = providerInput.parse({
    name: "Ollama",
    authMode: "api_key",
    apiConfig: connection.apiConfig,
  });
  assert.equal(local.apiConfig?.modelIds[0], "qwen3:8b");
  for (const baseUrl of [
    "http://example.com/v1",
    "https://user:secret@example.com/v1",
    "https://example.com/v1?key=secret",
    "file:///tmp/models",
  ]) {
    assert.equal(
      apiConnectionSchema.safeParse({ ...connection.apiConfig, baseUrl })
        .success,
      false,
      baseUrl,
    );
  }
  assert.equal(
    providerInput.safeParse({
      name: "Hosted",
      authMode: "api_key",
      apiConfig: { ...connection.apiConfig, baseUrl: "https://example.com/v1" },
    }).success,
    false,
  );
});

test("connection configuration cannot inject arbitrary child-process environment variables", () => {
  for (const envName of [
    "NODE_OPTIONS",
    "PATH",
    "OPENBOT_INTERNAL_TOKEN",
    "LD_PRELOAD",
    "OPENCODE_CONFIG_CONTENT",
  ]) {
    assert.equal(
      providerInput.safeParse({
        name: "Key",
        authMode: "api_key",
        secret: "value",
        envName,
      }).success,
      false,
    );
  }
  assert.equal(
    providerInput.safeParse({
      name: "Key",
      authMode: "api_key",
      secret: "value",
      envName: "OPENAI_API_KEY",
    }).success,
    true,
  );
});

test("keeps custom models scoped to the exact saved connection, including local tags", () => {
  assert.deepEqual(configuredModels(connection), [
    "openbot-test-provider/qwen3:8b",
    "openbot-test-provider/org/my-model",
  ]);
  assert.equal(
    modelBelongsToConnection("openbot-test-provider/qwen3:8b", connection),
    true,
  );
  assert.equal(modelBelongsToConnection("openai/anything", connection), false);
  assert.equal(
    modelBelongsToConnection("openbot-other/qwen3:8b", connection),
    false,
  );
  assert.equal(
    modelBelongsToConnection("openrouter/org/model", {
      ...connection,
      apiConfig: null,
      envName: "OPENROUTER_API_KEY",
    }),
    true,
  );
  assert.equal(
    modelBelongsToConnection("openai/model", {
      ...connection,
      apiConfig: null,
      envName: "OPENROUTER_API_KEY",
    }),
    false,
  );
});

test("passes endpoint and model configuration to the real runtime without putting keys in JSON", () => {
  const env = apiRuntimeEnvironment(connection, "only-this-key");
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  assert.deepEqual(config.enabled_providers, ["openbot-test-provider"]);
  assert.equal(
    config.provider["openbot-test-provider"].npm,
    "@ai-sdk/openai-compatible",
  );
  assert.equal(
    config.provider["openbot-test-provider"].options.baseURL,
    connection.apiConfig?.baseUrl,
  );
  assert.equal(env.OPENBOT_MODEL_API_KEY, "only-this-key");
  assert.equal(env.OPENCODE_CONFIG_CONTENT?.includes("only-this-key"), false);
  assert.equal(
    apiRuntimeEnvironment(connection, null).OPENBOT_MODEL_API_KEY,
    undefined,
  );
  assert.deepEqual(
    apiRuntimeEnvironment(
      { ...connection, apiConfig: null, envName: "NODE_OPTIONS" },
      "--inject",
    ),
    {},
  );
});

test("free-tier suffix detection names the tier without judging other models", () => {
  assert.equal(isFreeTierModel("opencode/muse-spark-1.3-contributor-free"), true);
  assert.equal(isFreeTierModel("opencode-go/mimo-v2.5-free"), true);
  assert.equal(isFreeTierModel("custom/free"), true);
  assert.equal(isFreeTierModel("opencode-go/deepseek-v4.1-flash"), false);
  assert.equal(isFreeTierModel("opencode-go/glm-5.3-flash"), false);
  assert.equal(isFreeTierModel("opencode-go/muse-spark-1.3-contributor"), false);
  assert.equal(isFreeTierModel("local/freezer-model"), false);
  assert.equal(isFreeTierModel(""), false);
});

test("model choices lead with a recommendation and never offer OpenCode's app-only free tier", async () => {
  const { modelChoices, defaultModelChoice, friendlyModelName, isBlockedFreeTierModel } = await import("./provider-config.js");
  const models = ["opencode/big-pickle", "opencode/muse-spark-1.3-contributor-free", "opencode-go/muse-spark-1.3-contributor", "opencode-go/deepseek-v4.1-flash", "opencode-go/gpt-5.6-luna"];
  const choices = modelChoices(models);
  assert.equal(choices[0]!.value, "opencode-go/deepseek-v4.1-flash");
  assert.equal(choices[0]!.detail, "Recommended");
  assert.equal(choices.at(-1)!.value, "opencode/muse-spark-1.3-contributor-free");
  assert.equal(choices.at(-1)!.disabled, true);
  assert.equal(defaultModelChoice(models), "opencode-go/deepseek-v4.1-flash");
  assert.equal(defaultModelChoice(["anthropic/claude-x"]), "", "no guess for other connections");
  assert.equal(friendlyModelName("opencode-go/gpt-5.6-luna"), "GPT 5.6 Luna");
  assert.equal(friendlyModelName("opencode-go/muse-spark-1.3-contributor"), "Muse Spark 1.3 Contributor");
  assert.equal(friendlyModelName("opencode-go/glm-5.3-flash"), "GLM 5.3 Flash");
  assert.equal(friendlyModelName("opencode-go/deepseek-v4.1-flash"), "DeepSeek V4.1 Flash");
  assert.equal(friendlyModelName("opencode/space-bunny-free"), "Space Bunny");
  assert.equal(friendlyModelName("claude-code/opus"), "Opus 5.5");
  assert.equal(friendlyModelName("claude-code/sonnet"), "Sonnet 5.5");
  assert.equal(friendlyModelName("claude-code/haiku"), "Haiku 5.5");
  assert.equal(friendlyModelName("claude-opus-5-5"), "Claude Opus 5.5");
  assert.equal(friendlyModelName("opencode-go/claude-haiku-5-5"), "Claude Haiku 5.5");
  assert.equal(isBlockedFreeTierModel("openrouter/some-model-free"), false, "only OpenCode's own free tier is app-locked");
});

test("models whose provider may train on prompts are labelled, ranked after the others and never recommended", async () => {
  const { modelChoices, defaultModelChoice, mayTrainOnPrompts, RECOMMENDED_MODELS, TRAINING_NOTICE } = await import("./provider-config.js");
  assert.equal(mayTrainOnPrompts("opencode-go/muse-spark-1.3-contributor"), true);
  assert.equal(mayTrainOnPrompts("opencode-go/muse-spark-1.2-contributor"), true);
  assert.equal(mayTrainOnPrompts("opencode/muse-spark-1.2-contributor-free"), true);
  assert.equal(mayTrainOnPrompts("opencode-go/deepseek-v4.1-flash"), false);
  assert.equal(mayTrainOnPrompts("opencode-go/muse-spark-1.3"), false, "only the Contributor version trades prompts for price");
  assert.equal(mayTrainOnPrompts("openrouter/acme/contributor"), false);
  assert.ok(RECOMMENDED_MODELS.every((model) => !mayTrainOnPrompts(model)));
  assert.match(TRAINING_NOTICE, /may use your prompts to train/);

  const choices = modelChoices(["opencode-go/muse-spark-1.3-contributor", "opencode-go/glm-5.3-flash", "opencode/mimo-v2.5-free"]);
  assert.deepEqual(choices.map((choice) => choice.value), ["opencode-go/glm-5.3-flash", "opencode-go/muse-spark-1.3-contributor", "opencode/mimo-v2.5-free"]);
  assert.equal(choices[1]!.detail, "May train on your prompts");
  assert.equal(choices[1]!.disabled, undefined, "still selectable on purpose");
  assert.equal(defaultModelChoice(["opencode-go/muse-spark-1.3-contributor"]), "", "never preselected");
});

test("a connection without a known-good model starts on its own default, never a failing or training one", async () => {
  const { defaultModelChoice, modelChoices } = await import("./provider-config.js");
  const claude = ["claude-code/sonnet", "claude-code/opus", "claude-code/haiku"];
  assert.equal(defaultModelChoice(claude), "", "no guess without a default");
  assert.equal(defaultModelChoice(claude, "claude-code/sonnet"), "claude-code/sonnet");
  assert.equal(modelChoices(claude, "claude-code/sonnet")[0]!.detail, "Recommended");
  assert.equal(defaultModelChoice(["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"], "opencode-go/glm-5.3-flash"), "opencode-go/deepseek-v4.1-flash", "a known-good model still wins");
  assert.equal(defaultModelChoice(["opencode/mimo-v2.5-free"], "opencode/mimo-v2.5-free"), "");
  assert.equal(defaultModelChoice(["opencode-go/muse-spark-1.3-contributor"], "opencode-go/muse-spark-1.3-contributor"), "");
  assert.equal(defaultModelChoice(claude, "claude-code/missing"), "");
});
