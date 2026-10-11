/** Records the "Waiting for you" demo from a throwaway studio full of SAMPLE data. Nothing real is on screen and
 * nothing real is touched: the studio runs in sample Mac mode (SIDEMATES_DEMO_MAC=sample), so approving a card
 * answers as if it worked but writes no reminder, event, draft or file. The queue, the checks and the trust
 * rules are the real ones. The page says "Sample data" the whole time, and the clip ends on a card saying so.
 *
 *   node --import tsx scripts/record-queue-demo.mjs [--vertical] [--out marketing/queue/media/demo-waiting-for-you.mp4]
 *                                                    [--dist path/to/built/ui] [--hold 1]
 *
 * Needs Google Chrome and ffmpeg. Builds the studio UI first unless --dist points at a fresh build.
 * Output goes under marketing/queue/media/ (ignored by git). */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--") ? process.argv[index + 1] : fallback;
};
const vertical = process.argv.includes("--vertical");
const out = path.resolve(root, arg("out", `marketing/queue/media/demo-waiting-for-you${vertical ? "-vertical" : ""}.mp4`));
const chrome = arg("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const hold = Number(arg("hold", "1"));
if (spawnSync("ffmpeg", ["-version"]).status !== 0) { console.error("ffmpeg is required (brew install ffmpeg)."); process.exit(2); }

const work = mkdtempSync(path.join(tmpdir(), "sidemates-queue-demo-"));
mkdirSync(path.dirname(out), { recursive: true });

// 1. The UI, built fresh unless a build was given.
let dist = arg("dist", "");
if (!dist) {
  dist = path.join(work, "dist");
  const built = spawnSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], { cwd: root, encoding: "utf8" });
  if (built.status !== 0) { console.error(String(built.stdout + built.stderr).slice(-1500)); process.exit(1); }
}

// 2. A studio of our own, filled with sample data the way a real morning would look.
const { startSampleStudio } = await import("./lib/sample-studio.mjs");
const sampleStudio = await startSampleStudio({ root, work, dist });
const studio = sampleStudio.studio;
const stopStudio = () => { sampleStudio.stop(); rmSync(work, { recursive: true, force: true }); };
process.on("exit", stopStudio);

// 3. Record the screen: a visible cursor and a short caption for each step.
const size = vertical ? { width: 540, height: 960 } : { width: 1280, height: 720 };
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, recordVideo: { dir: work, size }, colorScheme: "light" });
await context.addInitScript(({ captionSize }) => {
  const add = () => {
    if (document.getElementById("demo-cursor")) return;
    const style = document.createElement("style");
    style.textContent = `#demo-cursor{position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:rgba(10,110,255,.28);border:2.5px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none;z-index:2147483646;transition:transform .12s ease,background .12s ease;transform:translate(-100px,-100px)}
      #demo-cursor.down{background:rgba(10,110,255,.7);width:20px;height:20px;margin:-10px 0 0 -10px}
      #demo-badge{position:fixed;right:14px;top:12px;padding:5px 11px;border-radius:999px;background:rgba(20,20,24,.82);color:#fff;font:600 12.5px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;z-index:2147483645;pointer-events:none}
      #demo-caption{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);max-width:88%;padding:11px 20px;border-radius:14px;background:rgba(20,20,24,.9);color:#fff;font:600 ${captionSize}px/1.35 -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;text-align:center;z-index:2147483645;pointer-events:none;opacity:0;transition:opacity .25s ease}
      #demo-caption.on{opacity:1}`;
    document.head.appendChild(style);
    const cursor = document.createElement("div"); cursor.id = "demo-cursor"; document.body.appendChild(cursor);
    const caption = document.createElement("div"); caption.id = "demo-caption"; document.body.appendChild(caption);
    const badge = document.createElement("div"); badge.id = "demo-badge"; badge.textContent = "Sample data · demo studio"; document.body.appendChild(badge);
    window.addEventListener("mousemove", (event) => { cursor.style.transform = `translate(${event.clientX}px,${event.clientY}px)`; }, true);
    window.addEventListener("mousedown", () => cursor.classList.add("down"), true);
    window.addEventListener("mouseup", () => cursor.classList.remove("down"), true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
}, { captionSize: vertical ? 17 : 21 });
const page = await context.newPage();
const started = Date.now();
const at = () => (Date.now() - started) / 1000;
const caption = async (text) => { await page.evaluate((value) => { const el = document.getElementById("demo-caption"); if (!el) return; el.classList.remove("on"); setTimeout(() => { el.textContent = value; if (value) el.classList.add("on"); }, 220); }, text); };
const card = (title) => page.locator("li.waiting-card").filter({ hasText: title });
const center = async (locator) => {
  await locator.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await page.waitForTimeout(750);
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const click = async (locator) => {
  const { x, y } = await center(locator);
  await page.mouse.move(x, y, { steps: 28 });
  await page.waitForTimeout(350);
  await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
};
await page.mouse.move(size.width * 0.8, size.height * 0.3);
await page.goto(studio);
await page.locator(".waiting-card").first().waitFor({ timeout: 30_000 });
await page.waitForTimeout(1200);
const tStart = at();

await caption("While you were away, your team prepared 4 things.");
await page.waitForTimeout(3300);
await caption("Nothing happens until you say so.");
await page.waitForTimeout(2300);
await caption("Approve a reply: it is saved as a draft. Never sent.");
await click(card("Reply to Anna").getByRole("button", { name: "Save draft" }));
await page.waitForTimeout(2400);
await caption("An invoice? It files it and keeps the amount for your accountant.");
await click(card("File Acme invoice 1045").getByRole("button", { name: "Save file" }));
await page.waitForTimeout(1800);
await page.locator(".waiting-offer").waitFor({ timeout: 10_000 });
await caption("Approved the same kind five times? It offers to do it for you.");
await page.locator(".waiting-offer").evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
await page.waitForTimeout(3800);
await caption("Only that exact kind, from that sender, runs by itself.");
await click(page.getByRole("button", { name: "Yes, do these automatically" }));
await page.waitForTimeout(2600);
await caption("Everything else still waits for you, with Undo.");
await click(card("Pay the gas bill").getByRole("button", { name: "Add reminder" }));
await page.waitForTimeout(1700);
await click(page.locator(".waiting-done-row").filter({ hasText: "Pay the gas bill" }).getByRole("button", { name: /Undo/ }));
await page.waitForTimeout(2600);
await caption("Month-end? One list for your accountant.");
await page.locator(".waiting-receipts").evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
await page.waitForTimeout(900);
const download = page.locator(".waiting-receipts a");
const dl = await center(download);
await page.mouse.move(dl.x, dl.y, { steps: 30 });
await page.waitForTimeout(3600);
await caption("");
await page.waitForTimeout(hold * 1000);
const total = at();
await context.close();
const video = await page.video().path();

// The end card is an image rendered by the same browser (this ffmpeg build has no text filter).
const cardPath = path.join(work, "end-card.png");
const cardPage = await (await browser.newContext({ viewport: size, deviceScaleFactor: 1 })).newPage();
await cardPage.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#1b1b1f;color:#fff;font:800 ${vertical ? 34 : 46}px/1.25 ui-rounded,-apple-system,system-ui,sans-serif;text-align:center"><div><div>Waiting for you</div><div style="margin-top:14px;font-weight:600;font-size:${vertical ? 20 : 26}px;opacity:.86">Your team prepares it. You decide. Undo anything.</div><div style="margin-top:34px;font-weight:700;font-size:${vertical ? 22 : 30}px">sidemates.app</div><div style="margin-top:10px;font-weight:500;font-size:${vertical ? 14 : 17}px;opacity:.6">Free and open source · This clip uses sample data</div></div></body>`);
await cardPage.screenshot({ path: cardPath });
await browser.close();

// Cut the page load off the front and add the end card.
const fps = 30, w = size.width, h = size.height;
const filter = [
  `[0:v]trim=${Math.max(0, tStart - 0.3)}:${total + 0.5},setpts=PTS-STARTPTS,fps=${fps},scale=${w}:${h}[a]`,
  `[1:v]fps=${fps},scale=${w}:${h},setsar=1[d]`,
  `[a][d]concat=n=2:v=1:a=0,format=yuv420p[v]`,
].join(";");
const result = spawnSync("ffmpeg", ["-y", "-i", video, "-loop", "1", "-t", "3", "-i", cardPath, "-filter_complex", filter, "-map", "[v]", "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-movflags", "+faststart", out], { encoding: "utf8" });
if (result.status !== 0) { console.error(String(result.stderr).slice(-1500)); process.exit(1); }
console.log(`Wrote ${path.relative(root, out)} (about ${(total - tStart + 3.5).toFixed(0)}s).`);
stopStudio();
process.exit(0);
