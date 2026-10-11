/** Puts Apple-style words over a rendered frame, to judge the whole look from one picture.
 *   node scripts/motion/compose-still.mjs <in.png> <out.png> <layout top|left> "<headline>" "<sub line>" */
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const [input, output, layout = "top", headline = "", sub = ""] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
const words = layout === "left"
  ? `left:150px; top:50%; translate:0 -55%; width:760px; text-align:left`
  : `left:0; right:0; top:120px; text-align:center`;
await page.setContent(`<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:1920px;height:1080px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  img{position:absolute;inset:0;width:1920px;height:1080px}
  .w{position:absolute;${words}}
  h1{margin:0;font-size:${layout === "left" ? 108 : 112}px;font-weight:620;letter-spacing:-.035em;line-height:1.02;color:#1d1d1f}
  p{margin:26px 0 0;font-size:${layout === "left" ? 38 : 38}px;font-weight:500;letter-spacing:-.012em;line-height:1.3;color:#6e6e73}
</style><img src="data:image/png;base64,${readFileSync(path.resolve(input)).toString("base64")}"><div class="w"><h1>${headline}</h1>${sub ? `<p>${sub}</p>` : ""}</div>`);
await page.waitForTimeout(400);
await page.screenshot({ path: output });
await browser.close();
console.log("Wrote", output);
