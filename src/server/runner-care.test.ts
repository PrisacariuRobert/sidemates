import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectRunnerCare } from "./runner-care.js";
import type { DeploymentConfig } from "./deployment.js";

const config: DeploymentConfig = {
  mode: "private_runner",
  appUrl: "https://studio.example.com/",
  callbackBaseUrl: "https://studio.example.com/",
  dataDir: "/srv/openbot/data",
  trustProxy: true,
};

test("reports real private-runner tools and a recent backup", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "openbot-runner-care-"));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.26.0" }));
  writeFileSync(path.join(dataDir, "runner-maintenance.json"), JSON.stringify({
    lastBackupAt: "2026-09-04T12:00:00.000Z",
    lastBackupBytes: 2_048,
    lastBackupFile: "openbot-20260904T120000Z.tar.gz",
    release: "0.25.0",
  }));
  writeFileSync(path.join(dataDir, "runner-update.json"), JSON.stringify({
    lastUpdateAt: "2026-09-03T12:00:00.000Z",
    fromVersion: "0.24.0",
    toVersion: "0.26.0",
    revision: "abcdef1234567",
  }));
  try {
    const result = await inspectRunnerCare({
      config,
      dataDir,
      rootDir: root,
      now: Date.parse("2026-09-04T18:00:00.000Z"),
      disk: () => ({ total: 500 * 1_024 ** 3, free: 200 * 1_024 ** 3 }),
      run: async (command) => ({ ok: true, output: command === "docker" ? "28.0.4" : "1.2.3" }),
    });
    assert.equal(result.version, "0.26.0");
    assert.equal(result.publicUrl, "https://studio.example.com/");
    assert.equal(result.overall, "ready");
    assert.equal(result.checks.find((check) => check.id === "backup")?.value, "Today · 2 KB");
    assert.match(result.checks.find((check) => check.id === "software")?.detail || "", /0\.24\.0 → 0\.26\.0/);
    assert.ok(result.checks.every((check) => check.status === "ready"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turns missing tools and an old backup into friendly attention items", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "openbot-runner-care-"));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.26.0" }));
  writeFileSync(path.join(dataDir, "runner-maintenance.json"), JSON.stringify({
    lastBackupAt: "2026-08-01T12:00:00.000Z",
    lastBackupBytes: 1_024,
    lastBackupFile: "openbot-20260801T120000Z.tar.gz",
    release: "0.24.0",
  }));
  try {
    const result = await inspectRunnerCare({ config, dataDir, rootDir: root, now: Date.parse("2026-09-04T18:00:00.000Z"), run: async () => ({ ok: false, output: "" }) });
    assert.equal(result.overall, "attention");
    assert.equal(result.checks.find((check) => check.id === "backup")?.status, "attention");
    assert.equal(result.checks.find((check) => check.id === "computers")?.value, "Needs attention");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
