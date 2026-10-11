/** Renders the words-and-cursor layer of the 3D film as transparent PNG frames, and can put the film together.
 *
 *   node scripts/motion/render-overlay.mjs --targets marketing/queue/media/film3d/targets-landscape.json \
 *        --out marketing/queue/media/film3d/overlay-landscape [--format landscape|vertical] [--width 1920 --height 1080]
 *   node scripts/motion/render-overlay.mjs --compose --frames <dir> --overlay <dir> --audio <wav> --out <file.mp4>
 *
 * Needs Google Chrome and ffmpeg. Output goes under marketing/queue/media/ (ignored by git). */
import { mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--") ? process.argv[index + 1] : fallback;
};

if (process.argv.includes("--compose")) {
  const frames = path.resolve(root, arg("frames", "")), overlay = path.resolve(root, arg("overlay", "")), audio = arg("audio", "");
  const out = path.resolve(root, arg("out", "marketing/queue/media/film3d/film.mp4"));
  const inputs = ["-framerate", "24", "-i", path.join(frames, "f_%04d.png"), "-framerate", "24", "-i", path.join(overlay, "o_%04d.png")];
  if (audio) inputs.push("-i", path.resolve(audio));
  const made = spawnSync("ffmpeg", ["-y", ...inputs, "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto,format=yuv420p[v]", "-map", "[v]",
    ...(audio ? ["-map", "2:a", "-c:a", "aac", "-b:a", "192k", "-shortest"] : []),
    "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-tune", "film", "-movflags", "+faststart", out], { encoding: "utf8" });
  if (made.status !== 0) { console.error(String(made.stderr).slice(-2000)); process.exit(1); }
  console.log("Wrote", path.relative(root, out));
  process.exit(0);
}

const format = arg("format", "landscape");
const width = Number(arg("width", format === "vertical" ? "1080" : "1920")), height = Number(arg("height", format === "vertical" ? "1920" : "1080"));
const targets = JSON.parse(readFileSync(path.resolve(root, arg("targets", "")), "utf8"));
const out = path.resolve(root, arg("out", `marketing/queue/media/film3d/overlay-${format}`));
const only = arg("frames", "");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })).newPage();
await page.goto(`file://${path.join(root, "scripts/motion/film-overlay.html")}?format=${format}`);
await page.evaluate((t) => { window.TARGETS = t; }, targets);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15_000 });
const total = await page.evaluate(() => window.__frames);
const [first, last] = only ? only.split("-").map(Number) : [1, total];
for (let f = first; f <= last; f++) {
  await page.evaluate((n) => window.__seek(n), f);
  await page.screenshot({ path: path.join(out, `o_${String(f).padStart(4, "0")}.png`), omitBackground: true });
  if (f % 120 === 0) console.log(`overlay ${f}/${last}`);
}
await browser.close();
console.log(`Wrote ${last - first + 1} overlay frames to ${path.relative(root, out)}`);
