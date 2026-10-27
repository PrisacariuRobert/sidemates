import test from "node:test";
import assert from "node:assert/strict";
import { resetStandaloneArgsForTests, standaloneArgs } from "./opencode-flags.js";

test("--standalone is added only when this OpenCode lists it, and asked once", () => {
  let asked = 0;
  resetStandaloneArgsForTests();
  assert.deepEqual(standaloneArgs(() => { asked++; return "FLAGS\n  --standalone    Run with a private server\n  --auto  Auto-approve"; }), ["--standalone"]);
  assert.deepEqual(standaloneArgs(() => { asked++; return ""; }), ["--standalone"], "remembered");
  assert.equal(asked, 1);
  resetStandaloneArgsForTests();
  assert.deepEqual(standaloneArgs(() => "FLAGS\n  --dir string  Directory\n  --auto"), []);
  resetStandaloneArgsForTests();
  assert.deepEqual(standaloneArgs(() => "--standalone-ish is not it"), []);
  resetStandaloneArgsForTests();
});
