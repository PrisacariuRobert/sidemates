// A transient version-probe failure must not wedge the host: only definitive
// verdicts stick, so the next task re-probes instead of failing forever.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyOpencodeVersion, opencodeCompatibility, resetBoundaryVerdictsForTests, runtimeMayExecute, VERIFIED_OPENCODE_VERSION } from "./runtime-compatibility.js";

test("unknown probe results are not cached; later reads recover", () => {
  assert.deepEqual(opencodeCompatibility({ refresh: true, probe: () => { throw new Error("transient"); } }),
    { runtime: "opencode", detectedVersion: null, compatibility: "unknown" });
  assert.deepEqual(opencodeCompatibility({ probe: () => VERIFIED_OPENCODE_VERSION }),
    { runtime: "opencode", detectedVersion: VERIFIED_OPENCODE_VERSION, compatibility: "verified" });
});

test("verified and unsupported verdicts stick", () => {
  assert.equal(opencodeCompatibility({ refresh: true, probe: () => VERIFIED_OPENCODE_VERSION }).compatibility, "verified");
  assert.equal(opencodeCompatibility({ probe: () => { throw new Error("must not run while cached"); } }).compatibility, "verified");
  assert.equal(opencodeCompatibility({ refresh: true, probe: () => "0.0.0" }).compatibility, "unsupported");
});

test("a newer patch in the verified line runs; other versions still fail closed", () => {
  const [major, minor, patch] = VERIFIED_OPENCODE_VERSION.split(".").map(Number);
  assert.equal(classifyOpencodeVersion(`${major}.${minor}.${patch + 1}`), "compatible");
  assert.equal(classifyOpencodeVersion(`v${major}.${minor}.${patch + 7}`), "compatible");
  assert.equal(classifyOpencodeVersion(`${major}.${minor + 1}.0`), "unsupported");
  assert.equal(classifyOpencodeVersion(`${major + 1}.${minor}.${patch}`), "unsupported");
  if (patch > 0) assert.equal(classifyOpencodeVersion(`${major}.${minor}.${patch - 1}`), "unsupported");
  assert.equal(classifyOpencodeVersion(`${major}.${minor}.${patch + 1}-beta`), "unsupported");
  assert.equal(runtimeMayExecute("compatible"), true);
  assert.equal(runtimeMayExecute("unsupported"), false);
  assert.equal(runtimeMayExecute("unknown"), false);
});

test("a new OpenCode version runs once its safety rules pass the automatic check, and stays paused with the reason when they do not", () => {
  resetBoundaryVerdictsForTests();
  let checks = 0;
  const passing = () => { checks += 1; return { ok: true, reasons: [] }; };
  const newer = opencodeCompatibility({ refresh: true, probe: () => "9.1.0", boundaryCheck: passing });
  assert.equal(newer.compatibility, "checked");
  assert.equal(runtimeMayExecute(newer.compatibility), true);
  assert.equal(newer.detectedVersion, "9.1.0");
  opencodeCompatibility({ refresh: true, probe: () => "9.1.0", boundaryCheck: passing });
  assert.equal(checks, 1, "the check runs once per version");
  const broken = opencodeCompatibility({ refresh: true, probe: () => "9.2.0", boundaryCheck: () => ({ ok: false, reasons: ["“bash” is not denied for teammates."] }) });
  assert.equal(broken.compatibility, "unsupported");
  assert.match(broken.detail || "", /bash/);
  assert.equal(runtimeMayExecute(broken.compatibility), false);
  // A version that is already verified or a compatible patch never needs the check.
  let unexpected = 0;
  opencodeCompatibility({ refresh: true, probe: () => VERIFIED_OPENCODE_VERSION, boundaryCheck: () => { unexpected += 1; return { ok: true, reasons: [] }; } });
  assert.equal(unexpected, 0);
  resetBoundaryVerdictsForTests();
  opencodeCompatibility({ refresh: true, probe: () => VERIFIED_OPENCODE_VERSION });
});

