// Builds Sidemates' bridge to Apple's built-in AI (native/apple-ai) into
// bin/apple-ai. Only on a Mac with a Swift compiler and the Apple
// Intelligence SDK; anywhere else it says so and steps aside, because
// Sidemates works without it.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (process.platform !== 'darwin') process.exit(0);
const output = path.join(root, 'bin', 'apple-ai');
mkdirSync(path.dirname(output), { recursive: true });
const built = spawnSync('swiftc', ['-O', '-parse-as-library', '-suppress-warnings', '-o', output, path.join(root, 'native/apple-ai/AppleAI.swift')], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
if (built.status === 0) console.log("Built Apple's built-in AI bridge (bin/apple-ai).");
else console.log("Skipped Apple's built-in AI bridge: this Mac can't build it (needs Xcode with the Apple Intelligence SDK). Sidemates works without it.");
