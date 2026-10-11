/** Renders a motion-graphics film from an HTML timeline (scripts/motion/*.html) to an MP4, one exact frame at a time.
 * The page exposes window.__seek(seconds) and window.__duration; nothing is recorded live, so the result is the same
 * every time and does not depend on how fast this Mac is. No network, no paid tools.
 *
 *   node scripts/render-motion.mjs [--film waiting-for-you] [--format vertical|landscape|square] [--fps 30]
 *                                  [--out marketing/queue/media/film-waiting-for-you-vertical.mp4]
 *   node scripts/render-motion.mjs --preview 0.8,2.6,4.8,9,12.5,16.5,20.8,23.5,27,29.5   (a contact sheet to check the film)
 *
 * Needs Google Chrome and ffmpeg. Output goes under marketing/queue/media/ (ignored by git). */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--") ? process.argv[index + 1] : fallback;
};
const film = arg("film", "waiting-for-you");
const format = arg("format", "vertical");
const fps = Number(arg("fps", "30"));
const preview = arg("preview", "");
const audio = arg("audio", "");   // a WAV to lay under the film, e.g. from scripts/motion/make-audio.mjs
const chrome = arg("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const sizes = { vertical: { width: 1080, height: 1920 }, landscape: { width: 1920, height: 1080 }, square: { width: 1080, height: 1080 } };
const size = sizes[format];
if (!size) { console.error(`Unknown format ${format}. Use vertical, landscape or square.`); process.exit(2); }
if (spawnSync("ffmpeg", ["-version"]).status !== 0) { console.error("ffmpeg is required (brew install ffmpeg)."); process.exit(2); }
const out = path.resolve(root, arg("out", `marketing/queue/media/film-${film}-${format}.mp4`));

// The page is a template: the teammates' drawings come from the site's own character files.
const work = mkdtempSync(path.join(tmpdir(), "sidemates-film-"));
const character = (file) => readFileSync(path.join(root, "site/characters", file), "utf8").replace(/<svg /, '<svg aria-hidden="true" ');
const html = readFileSync(path.join(root, "scripts/motion", `${film}.html`), "utf8")
  .replaceAll("{{nova}}", () => character("nova.svg"))
  .replaceAll("{{pixel}}", () => character("blob.svg")).replaceAll("{{scout}}", () => character("sprout.svg"))
  // Real pieces of the screen, captured by scripts/capture-queue-stills.mjs (node --import tsx scripts/capture-queue-stills.mjs).
  .replaceAll("{{stills}}", () => `file://${path.resolve(root, arg("stills", "marketing/queue/media/stills"))}`);
const page_file = path.join(work, "film.html");
writeFileSync(page_file, html);

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: "light" });
const page = await context.newPage();
await page.goto(`file://${page_file}?format=${format}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15_000 });
const duration = await page.evaluate(() => window.__duration);
const shot = async (seconds, file) => { await page.evaluate((t) => window.__seek(t), seconds); await page.screenshot({ path: file, type: "png" }); };

try {
  if (preview) {
    const times = preview.split(",").map(Number);
    for (const [i, t] of times.entries()) await shot(t, path.join(work, `p${String(i).padStart(3, "0")}.png`));
    const sheet = path.resolve(root, arg("out", `marketing/queue/media/sheet-${film}-${format}.png`));
    mkdirSync(path.dirname(sheet), { recursive: true });
    const columns = format === "landscape" ? 2 : 5, rows = Math.ceil(times.length / columns);
    const tileW = format === "landscape" ? 640 : 300;
    const made = spawnSync("ffmpeg", ["-y", "-framerate", "1", "-i", path.join(work, "p%03d.png"), "-vf", `scale=${tileW}:-1,tile=${columns}x${rows}:padding=6:color=0xdddddd`, "-frames:v", "1", sheet], { encoding: "utf8" });
    if (made.status !== 0) { console.error(String(made.stderr).slice(-1200)); process.exit(1); }
    console.log(`Wrote ${path.relative(root, sheet)} (${times.length} moments of ${duration}s).`);
  } else {
    mkdirSync(path.dirname(out), { recursive: true });
    const frames = Math.round(duration * fps);
    for (let i = 0; i < frames; i++) {
      await shot(i / fps, path.join(work, `f${String(i).padStart(5, "0")}.png`));
      if (i % 90 === 0) console.log(`frame ${i}/${frames}`);
    }
    const inputs = ["-framerate", String(fps), "-i", path.join(work, "f%05d.png"), ...(audio ? ["-i", path.resolve(audio)] : [])];
    const codecs = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "15", "-preset", "medium", ...(audio ? ["-c:a", "aac", "-b:a", "192k", "-shortest"] : []), "-movflags", "+faststart"];
    const made = spawnSync("ffmpeg", ["-y", ...inputs, ...codecs, out], { encoding: "utf8" });
    if (made.status !== 0) { console.error(String(made.stderr).slice(-1500)); process.exit(1); }
    console.log(`Wrote ${path.relative(root, out)} (${duration}s, ${size.width}x${size.height}, ${fps} fps).`);
  }
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
