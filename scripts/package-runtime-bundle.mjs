// Portable Sidemates runtime bundle for one OS/arch: pinned Node + pinned
// opencode + the app tree with per-platform dependencies, a launcher and a
// manifest. macOS desktop users should prefer the .app package; this bundle
// is the headless/terminal route for Linux, Windows and Mac terminals.
//
// Usage:
//   node scripts/package-runtime-bundle.mjs --platform linux-x64|win-x64|darwin-arm64
//     [--node 22.21.0] [--opencode 1.18.29|latest] [--out dist-release] [--no-install] [--smoke]
//
// Network is required: Node comes from nodejs.org (SHA verified), opencode
// from the anomalyco/opencode releases. Nothing is executed except an
// optional same-host smoke boot and `--version` probes.
import { chmodSync, copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const root = path.resolve(import.meta.dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).map((arg, index, all) => arg.startsWith("--") ? [arg.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : "1"] : []).filter(([key]) => key));

const PLATFORMS = {
  "linux-x64": { nodeFile: (v) => `node-v${v}-linux-x64.tar.gz`, nodeURL: (v) => `https://nodejs.org/dist/v${v}/node-v${v}-linux-x64.tar.gz`, nodeBin: ["bin", "node"], opencodeAsset: (v) => `opencode-linux-x64.tar.gz`, archive: "tar.gz" },
  "win-x64": { nodeFile: (v) => `node-v${v}-win-x64.zip`, nodeURL: (v) => `https://nodejs.org/dist/v${v}/node-v${v}-win-x64.zip`, nodeBin: ["node.exe"], opencodeAsset: (v) => `opencode-windows-x64.zip`, archive: "zip" },
  "darwin-x64": { nodeFile: (v) => `node-v${v}-darwin-x64.tar.gz`, nodeURL: (v) => `https://nodejs.org/dist/v${v}/node-v${v}-darwin-x64.tar.gz`, nodeBin: ["bin", "node"], opencodeAsset: (v) => `opencode-darwin-x64.zip`, archive: "tar.gz" },
  "darwin-arm64": { nodeFile: (v) => `node-v${v}-darwin-arm64.tar.gz`, nodeURL: (v) => `https://nodejs.org/dist/v${v}/node-v${v}-darwin-arm64.tar.gz`, nodeBin: ["bin", "node"], opencodeAsset: (v) => `opencode-darwin-arm64.zip`, archive: "tar.gz" },
};
const platform = args.platform || "";
if (!PLATFORMS[platform]) throw new Error(`Choose --platform ${Object.keys(PLATFORMS).join("|")}.`);
const spec = PLATFORMS[platform];
const outDir = path.resolve(args.out || path.join(root, "dist-release"));
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Refusing to release version ${version}.`);

async function resolveNodeVersion() {
  if (args.node && args.node !== "latest") {
    if (!/^\d+\.\d+\.\d+$/.test(args.node)) throw new Error("Pass an exact Node version such as --node 22.21.0.");
    return args.node;
  }
  const response = await fetch("https://nodejs.org/dist/index.json", { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("The Node release index could not be read.");
  const releases = await response.json();
  const pinned = releases.filter((entry) => entry.version.startsWith("v22.") && entry.lts).map((entry) => entry.version.slice(1));
  if (!pinned.length) throw new Error("No Node 22 LTS release found.");
  return pinned[0];
}

async function resolveOpencodeVersion() {
  if (args.opencode && args.opencode !== "latest") {
    if (!/^v?\d+\.\d+\.\d+$/.test(args.opencode)) throw new Error("Pass an exact opencode version such as --opencode 1.18.29.");
    return args.opencode.replace(/^v/, "");
  }
  const response = await fetch("https://api.github.com/repos/anomalyco/opencode/releases/latest", { signal: AbortSignal.timeout(30_000), headers: { Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  if (!response.ok) throw new Error(`The opencode release index could not be read (${response.status}).`);
  const tag = (await response.json()).tag_name;
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("The opencode release tag is not a version.");
  return tag.slice(1);
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${url} (${response.status}).`);
  await pipeline(response.body, createWriteStream(destination));
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(command, commandArgs, options = {}) {
  const windowsNpm = process.platform === "win32" && command === "npm";
  const executable = windowsNpm ? "npm.cmd" : command;
  const result = spawnSync(executable, commandArgs, { encoding: "utf8", timeout: 600_000, ...(windowsNpm ? { shell: true } : {}), ...options });
  if (result.status !== 0) throw new Error(`${executable} ${commandArgs.join(" ")} failed: ${(result.stderr || result.stdout || result.error?.message || "").slice(-2_000)}`);
  return result.stdout.trim();
}

const nodeVersion = await resolveNodeVersion();
const opencodeVersion = await resolveOpencodeVersion();
console.log(`Bundling Sidemates ${version} for ${platform} (node ${nodeVersion}, opencode ${opencodeVersion}).`);
const work = path.join(tmpdir(), `openbot-bundle-${platform}-${Date.now()}`);
mkdirSync(work, { recursive: true });

try {
  // Node, verified against the official SHASUMS.
  const nodeArchive = path.join(work, spec.nodeFile(nodeVersion));
  await download(spec.nodeURL(nodeVersion), nodeArchive);
  const sums = await (await fetch(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`, { signal: AbortSignal.timeout(60_000) })).text();
  const expected = sums.split("\n").find((line) => line.endsWith(`  ${spec.nodeFile(nodeVersion)}`))?.split(" ")[0];
  if (!expected || sha256(nodeArchive) !== expected) throw new Error("The Node download failed its SHA check.");
  // opencode CLI over HTTPS from the pinned release.
  const opencodeArchive = path.join(work, spec.opencodeAsset(opencodeVersion));
  await download(`https://github.com/anomalyco/opencode/releases/download/v${opencodeVersion}/${spec.opencodeAsset(opencodeVersion)}`, opencodeArchive);

  const bundleName = `sidemates-${version}-${platform}`;
  const stage = path.join(work, bundleName);
  const bin = path.join(stage, "bin"), app = path.join(stage, "app");
  mkdirSync(bin, { recursive: true });
  mkdirSync(app, { recursive: true });
  if (platform === "win-x64") {
    run("tar", ["-xf", nodeArchive, "-C", work]);
    copyFileSync(path.join(work, `node-v${nodeVersion}-win-x64`, "node.exe"), path.join(bin, "node.exe"));
    run("tar", ["-xf", opencodeArchive, "-C", bin]);
    if (!existsSync(path.join(bin, "opencode.exe"))) throw new Error("The opencode archive did not contain opencode.exe.");
  } else {
    run("tar", ["-xzf", nodeArchive, "-C", work]);
    const nodeBin = path.join(work, `node-v${nodeVersion}-${platform}`, ...spec.nodeBin);
    copyFileSync(nodeBin, path.join(bin, "node"));
    chmodSync(path.join(bin, "node"), 0o755);
    const opencodeDir = path.join(work, "opencode-bin");
    mkdirSync(opencodeDir, { recursive: true });
    run("tar", ["-xf", opencodeArchive, "-C", opencodeDir]);
    const extracted = run("find", [opencodeDir, "-name", "opencode", "-type", "f"]).split("\n")[0];
    if (!extracted) throw new Error("The opencode archive did not contain an opencode binary.");
    copyFileSync(extracted, path.join(bin, "opencode"));
    chmodSync(path.join(bin, "opencode"), 0o755);
    // Apple's built-in AI bridge, when this Mac could build it (npm run build).
    const appleAi = path.join(root, "bin", "apple-ai");
    if (platform.startsWith("darwin") && existsSync(appleAi)) { copyFileSync(appleAi, path.join(bin, "apple-ai")); chmodSync(path.join(bin, "apple-ai"), 0o755); }
  }
  // App tree. Dependencies install per platform on the building host.
  for (const relative of ["dist", "src", "skills", "LICENSE", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json", "scripts/background-runner.mjs"]) {
    const source = path.join(root, relative);
    if (!existsSync(source)) throw new Error(`The release tree is missing ${relative}. Run npm install and npm run build first.`);
    const destination = path.join(app, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    if (statSync(source).isDirectory()) cpSync(source, destination, { recursive: true });
    else copyFileSync(source, destination);
  }
  if (args["no-install"] !== "1") {
    console.log("Installing production dependencies for the bundle…");
    run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: app, env: { ...process.env } });
  }
  // Launchers.
  const dataDirHint = platform === "win-x64" ? "%USERPROFILE%\\.openbot" : "$HOME/.openbot";
  writeFileSync(path.join(stage, "sidemates.sh"), `#!/bin/sh\n# Sidemates ${version} for ${platform}. Data lives in $OPENBOT_DATA_DIR or ${dataDirHint}.\nset -eu\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexport OPENBOT_DATA_DIR="\${OPENBOT_DATA_DIR:-${dataDirHint}}"\nPATH="$HERE/bin:$PATH"\nexec "$HERE/bin/node" "$HERE/app/scripts/background-runner.mjs" "$@"\n`);
  chmodSync(path.join(stage, "sidemates.sh"), 0o755);
  if (platform.startsWith("darwin-")) {
    // Sidemates.app wrapper (see desktop/mac-app): the installer builds it so
    // macOS lists privacy permissions as "Sidemates", not "node".
    const macApp = path.join(stage, "mac-app");
    mkdirSync(macApp, { recursive: true });
    copyFileSync(path.join(root, "desktop", "mac-app", "build-app.sh"), path.join(macApp, "build-app.sh"));
    copyFileSync(path.join(root, "desktop", "mac-app", "launcher.c"), path.join(macApp, "launcher.c"));
    copyFileSync(path.join(root, "desktop", "mac-app", "icon.png"), path.join(macApp, "icon.png"));
    chmodSync(path.join(macApp, "build-app.sh"), 0o755);
    if (process.platform === "darwin") {
      const built = spawnSync("clang", ["-O2", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=12.0", "-o", path.join(macApp, "Sidemates-launcher"), path.join(root, "desktop", "mac-app", "launcher.c")], { stdio: "inherit" });
      if (built.status !== 0) throw new Error("The Sidemates.app launcher could not be compiled.");
    }
  }
  writeFileSync(path.join(stage, "sidemates.ps1"), `# Sidemates ${version} for ${platform}. Data lives in $env:OPENBOT_DATA_DIR or $env:USERPROFILE\\.openbot.\n$here = Split-Path -Parent $MyInvocation.MyCommand.Path\nif (-not $env:OPENBOT_DATA_DIR) { $env:OPENBOT_DATA_DIR = Join-Path $env:USERPROFILE ".openbot" }\n$env:PATH = "$here\\bin;" + $env:PATH\n& "$here\\bin\\node.exe" "$here\\app\\scripts\\background-runner.mjs"\n`);
  writeFileSync(path.join(stage, "sidemates.cmd"), `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sidemates.ps1"\r\n`);
  writeFileSync(path.join(stage, "README.txt"), `Sidemates ${version} (${platform})\n\nStart:  ./sidemates.sh            (Linux/macOS terminal)\n        sidemates.ps1            (Windows PowerShell)\nThe studio opens at http://127.0.0.1:4311 once the runner reports ready.\nYour data stays in OPENBOT_DATA_DIR (default ${dataDirHint}).\nFirst run: choose an AI connection, create a teammate, give it a job.\n\nBundled: Node ${nodeVersion}, opencode ${opencodeVersion} (licenses/bundled-licenses).\nBeta limits: unsigned build, no auto-update. The Mac desktop app is separate.\n`);
  // Licenses.
  mkdirSync(path.join(stage, "bundled-licenses"), { recursive: true });
  const nodeLicense = await (await fetch(`https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`, { signal: AbortSignal.timeout(60_000) })).text();
  if (!nodeLicense.includes("Node.js")) throw new Error("The Node license could not be fetched.");
  writeFileSync(path.join(stage, "bundled-licenses", "Node-LICENSE.txt"), nodeLicense);
  const opencodeLicense = await (await fetch(`https://raw.githubusercontent.com/anomalyco/opencode/v${opencodeVersion}/LICENSE`, { signal: AbortSignal.timeout(60_000) })).text();
  if (!opencodeLicense.startsWith("MIT License")) throw new Error("The opencode license could not be fetched.");
  writeFileSync(path.join(stage, "bundled-licenses", "OpenCode-LICENSE.txt"), opencodeLicense);
  const nodeBinName = platform === "win-x64" ? "node.exe" : "node";
  const opencodeBinName = platform === "win-x64" ? "opencode.exe" : "opencode";
  const manifest = {
    schemaVersion: 1, app: "sidemates", version, platform,
    createdAt: new Date().toISOString(), nodeVersion, opencodeVersion,
    nodeSHA256: sha256(path.join(bin, nodeBinName)),
    openCodeSHA256: sha256(path.join(bin, opencodeBinName)),
    binaries: { node: `bin/${nodeBinName}`, opencode: `bin/${opencodeBinName}` },
  };
  writeFileSync(path.join(stage, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // Probes on matching hosts.
  const hostPlatform = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
  const matchesHost = (platform === "linux-x64" && hostPlatform === "linux-x64") || (platform === "win-x64" && hostPlatform === "win-x64") || (platform.startsWith("darwin-") && hostPlatform === platform);
  if (args.smoke !== "0" && matchesHost) {
    const probeBin = path.join(bin, platform === "win-x64" ? "node.exe" : "node");
    const reported = run(probeBin, ["--version"]);
    if (reported !== `v${nodeVersion}`) throw new Error(`Bundled node reports ${reported}.`);
    const opencodeReported = run(path.join(bin, platform === "win-x64" ? "opencode.exe" : "opencode"), ["--version"]);
    if (!/^\d+\.\d+\.\d+$/.test(opencodeReported) || opencodeReported !== opencodeVersion) throw new Error(`Bundled opencode reports ${opencodeReported}.`);
    console.log(`Bundled runtime OK: node ${reported}, opencode ${opencodeReported}.`);
  } else if (args.smoke !== "0") {
    console.log("Cross-platform bundle: same-host probes skipped.");
  }
  mkdirSync(outDir, { recursive: true });
  if (args['stage-only'] === '1') {
    const destination = path.join(outDir, bundleName);
    rmSync(destination, { recursive: true, force: true });
    cpSync(stage, destination, { recursive: true, verbatimSymlinks: true });
    console.log(`Staged ${destination}`);
  } else {
  const artifact = path.join(outDir, spec.archive === "zip" ? `${bundleName}.zip` : `${bundleName}.tar.gz`);
  rmSync(artifact, { force: true });
  if (spec.archive === "zip") run("zip", ["-qr", artifact, bundleName], { cwd: work });
  else run("tar", ["-czf", artifact, bundleName], { cwd: work });
  writeFileSync(`${artifact}.sha256`, `${sha256(artifact)}  ${path.basename(artifact)}\n`);
  console.log(`Released ${artifact}\nSHA256 ${sha256(artifact)}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
