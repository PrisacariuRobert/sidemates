import { execFile } from "node:child_process";
import { existsSync, readFileSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { RunnerCareCheck, RunnerCareSnapshot } from "../shared/types.js";
import type { DeploymentConfig } from "./deployment.js";
import { syncedFolderProvider } from "./synced-folder.js";

const execFileAsync = promisify(execFile);
type CommandResult = { ok: boolean; output: string };
type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

type MaintenanceRecord = {
  lastBackupAt: string;
  lastBackupBytes: number;
  lastBackupFile: string;
  release: string;
};

type UpdateRecord = {
  lastUpdateAt: string;
  fromVersion: string;
  toVersion: string;
  revision: string;
};

function compactVersion(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

async function execute(command: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      timeout: 5_000,
      maxBuffer: 32 * 1_024,
      env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "" },
    });
    return { ok: true, output: compactVersion(result.stdout || result.stderr) };
  } catch {
    return { ok: false, output: "" };
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function maintenanceRecord(dataDir: string): MaintenanceRecord | null {
  const recordPath = path.join(dataDir, "runner-maintenance.json");
  try {
    if (!existsSync(recordPath) || statSync(recordPath).size > 4_096) return null;
    const value = JSON.parse(readFileSync(recordPath, "utf8")) as Partial<MaintenanceRecord>;
    if (!value.lastBackupAt || !Number.isFinite(Date.parse(value.lastBackupAt))) return null;
    if (!Number.isFinite(value.lastBackupBytes) || Number(value.lastBackupBytes) < 0) return null;
    if (typeof value.lastBackupFile !== "string" || !/^openbot-[0-9TZ]+\.tar\.gz$/.test(value.lastBackupFile)) return null;
    return {
      lastBackupAt: value.lastBackupAt,
      lastBackupBytes: Number(value.lastBackupBytes),
      lastBackupFile: value.lastBackupFile,
      release: typeof value.release === "string" ? value.release.slice(0, 32) : "unknown",
    };
  } catch {
    return null;
  }
}

function updateRecord(dataDir: string): UpdateRecord | null {
  const recordPath = path.join(dataDir, "runner-update.json");
  try {
    if (!existsSync(recordPath) || statSync(recordPath).size > 4_096) return null;
    const value = JSON.parse(readFileSync(recordPath, "utf8")) as Partial<UpdateRecord>;
    const semver = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
    if (!value.lastUpdateAt || !Number.isFinite(Date.parse(value.lastUpdateAt))) return null;
    if (typeof value.fromVersion !== "string" || !semver.test(value.fromVersion)) return null;
    if (typeof value.toVersion !== "string" || !semver.test(value.toVersion)) return null;
    if (typeof value.revision !== "string" || !/^[a-f0-9]{7,40}$/.test(value.revision)) return null;
    return { lastUpdateAt: value.lastUpdateAt, fromVersion: value.fromVersion, toVersion: value.toVersion, revision: value.revision };
  } catch {
    return null;
  }
}

type DiskReader = (dataDir: string) => { total: number; free: number };

const readDisk: DiskReader = (dataDir) => {
  const stats = statfsSync(dataDir, { bigint: true });
  return { total: Number(stats.blocks * stats.bsize), free: Number(stats.bavail * stats.bsize) };
};

function storageCheck(dataDir: string, disk: DiskReader = readDisk): RunnerCareCheck {
  const synced = syncedFolderProvider(dataDir);
  if (synced) return { id: "storage", label: "Storage", status: "attention", value: `In ${synced}`, detail: "Move the data folder out of the synced folder; syncing a live database can corrupt it" };
  try {
    const { total, free } = disk(dataDir);
    const healthy = free >= 5 * 1_024 ** 3 && (total === 0 || free / total >= 0.1);
    return {
      id: "storage",
      label: "Storage",
      status: healthy ? "ready" : "attention",
      value: `${formatBytes(free)} free`,
      detail: healthy ? "Enough room for studio history and bot work" : "Free space is running low; clear or expand this volume",
    };
  } catch {
    return { id: "storage", label: "Storage", status: "attention", value: "Could not check", detail: "Sidemates could not read the durable data volume" };
  }
}

function backupCheck(dataDir: string, now: number): RunnerCareCheck {
  const record = maintenanceRecord(dataDir);
  if (!record) return { id: "backup", label: "Backup", status: "attention", value: "Not recorded yet", detail: "Create the first private backup from the host" };
  const ageDays = Math.max(0, Math.floor((now - Date.parse(record.lastBackupAt)) / 86_400_000));
  const healthy = ageDays <= 7;
  return {
    id: "backup",
    label: "Backup",
    status: healthy ? "ready" : "attention",
    value: ageDays === 0 ? `Today · ${formatBytes(record.lastBackupBytes)}` : `${ageDays} day${ageDays === 1 ? "" : "s"} ago`,
    detail: healthy ? `${record.lastBackupFile} was created successfully` : "Create a fresh backup before the next update",
  };
}

function softwareCheck(dataDir: string, version: string): RunnerCareCheck {
  const record = updateRecord(dataDir);
  if (!record) return { id: "software", label: "Software", status: "ready", value: `Sidemates ${version}`, detail: "Ready for a guided update with a backup first" };
  const updateDay = new Date(record.lastUpdateAt).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
  return {
    id: "software",
    label: "Software",
    status: "ready",
    value: `Sidemates ${version}`,
    detail: `${record.fromVersion} → ${record.toVersion} updated ${updateDay} after a successful backup`,
  };
}

function toolCheck(id: RunnerCareCheck["id"], label: string, result: CommandResult, readyDetail: string, missingDetail: string): RunnerCareCheck {
  return {
    id,
    label,
    status: result.ok ? "ready" : "attention",
    value: result.ok ? result.output || "Ready" : "Needs attention",
    detail: result.ok ? readyDetail : missingDetail,
  };
}

export async function inspectRunnerCare(input: {
  config: DeploymentConfig;
  dataDir: string;
  rootDir: string;
  chromePath?: string;
  run?: CommandRunner;
  now?: number;
  disk?: DiskReader;
}): Promise<RunnerCareSnapshot> {
  const run = input.run || execute;
  const packageJson = JSON.parse(readFileSync(path.join(input.rootDir, "package.json"), "utf8")) as { version?: string };
  const [openCode, browser, docker] = await Promise.all([
    run("opencode", ["--version"]),
    run(input.chromePath || "chromium", ["--version"]),
    run("docker", ["info", "--format", "{{.ServerVersion}}"]),
  ]);
  const version = packageJson.version || "unknown";
  const checks: RunnerCareCheck[] = [
    storageCheck(input.dataDir, input.disk),
    backupCheck(input.dataDir, input.now ?? Date.now()),
    softwareCheck(input.dataDir, version),
    toolCheck("opencode", "OpenCode", openCode, "Model runtime is available", "Reconnect or reinstall OpenCode on this host"),
    toolCheck("browser", "Browser", browser, "Chromium is available for browser work", "Chromium is missing or cannot start on this host"),
    toolCheck("computers", "Bot computers", docker, "Docker can create isolated teammate computers", "Docker is unavailable to the Sidemates service"),
  ];
  const attention = checks.filter((check) => check.status === "attention").length;
  return {
    checkedAt: new Date(input.now ?? Date.now()).toISOString(),
    mode: input.config.mode,
    version,
    uptimeSeconds: Math.max(0, Math.floor(process.uptime())),
    publicUrl: input.config.mode === "private_runner" ? input.config.appUrl : null,
    dataPath: input.dataDir,
    overall: attention === 0 ? "ready" : "attention",
    summary: attention === 0 ? "Your private home is ready" : `${attention} item${attention === 1 ? "" : "s"} need attention`,
    checks,
  };
}
