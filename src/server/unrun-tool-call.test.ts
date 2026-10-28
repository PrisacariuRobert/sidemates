import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeUnrunToolCall } from "./unrun-tool-call.js";

test("spots tool calls written out as text", () => {
  assert.equal(looksLikeUnrunToolCall("Done! <｜DSML｜tool_calls><｜DSML｜invoke name=\"openbot_workspace_write\">"), true);
  assert.equal(looksLikeUnrunToolCall("Writing it now.\n<function_calls>\n<invoke name=\"x\">"), true);
  assert.equal(looksLikeUnrunToolCall("<tool_call>{\"name\":\"x\"}</tool_call>"), true);
});

test("leaves normal answers and quoted code alone", () => {
  assert.equal(looksLikeUnrunToolCall("I wrote notes.txt and checked it."), false);
  assert.equal(looksLikeUnrunToolCall("A call looks like this:\n```\n<invoke name=\"x\">\n```\nOnly shown as an example."), false);
  assert.equal(looksLikeUnrunToolCall("Use `<tool_call>` tags in the prompt."), false);
  assert.equal(looksLikeUnrunToolCall(""), false);
});
