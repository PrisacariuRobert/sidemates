import path from "node:path";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { findTool } from "./video-render.js";

/** Saves one public video (and its captions as a timed transcript) into the
 * teammate's workspace so it can be cut into a short. This runs on the owner's
 * Mac, so it only accepts a short list of video sites, https only, and tells
 * yt-dlp to use just those sites' own extractors: a teammate cannot point it at
 * the owner's local network or an arbitrary host. */

const MAX_SECONDS = 3 * 60 * 60;
const MAX_FILE = "1G";
const INFO_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export const videoFetchInput = z.object({
  url: z.string().trim().url().max(2048),
}).strict();

const HOSTS = /^(?:(?:www|m)\.)?youtube\.com$|^youtu\.be$|^(?:www\.|player\.)?vimeo\.com$/i;

export function checkVideoUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("That is not a web address."); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("Only plain https video links are supported.");
  if (!HOSTS.test(url.hostname)) throw new Error("Only YouTube and Vimeo links can be saved. For other sites, ask the owner to download the video and add it as a file.");
  return url;
}

/** WebVTT captions → "[m:ss] text" lines. Auto captions repeat each line as
 * they scroll; the repeats are dropped. */
export function vttToTranscript(vtt: string): string {
  const out: string[] = [];
  let last = "";
  for (const block of vtt.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timing = lines.find((line) => line.includes("-->"));
    if (!timing) continue;
    const start = /(?:(\d+):)?(\d{2}):(\d{2})(?:[.,]\d+)?/.exec(timing);
    const text = lines.slice(lines.indexOf(timing) + 1).join(" ").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
    if (!start || !text || text === last) continue;
    const seconds = Number(start[1] || 0) * 3600 + Number(start[2]) * 60 + Number(start[3]);
    out.push(`[${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}] ${text}`);
    last = text;
  }
  return out.join("\n");
}

type Capture = (file: string, args: string[], timeout: number) => Promise<string>;
const capture: Capture = (file, args, timeout) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "" } }, (error, stdout, stderr) => {
    if (!error) return resolve(String(stdout));
    const detail = String(stderr || "").split("\n").filter((line) => /^ERROR/i.test(line)).pop() || String(stderr || "").trim().split("\n").pop() || "";
    reject(new Error((error as { killed?: boolean }).killed ? "Saving the video took too long and was stopped." : `The video could not be saved. ${detail.replace(/^ERROR:\s*/i, "").slice(0, 240)}`.trim()));
  });
});

const BASE = ["--ignore-config", "--no-plugin-dirs", "--no-playlist", "--no-exec", "--use-extractors", "youtube,vimeo", "--no-warnings"];

export async function fetchVideo(workspace: string, args: unknown, run: Capture = capture) {
  const { url: raw } = videoFetchInput.parse(args);
  const url = checkVideoUrl(raw).toString();
  const tool = findTool("yt-dlp");
  if (!tool) throw new Error("Video download is not installed on this Mac. Install yt-dlp (for example with Homebrew: brew install yt-dlp), then try again.");
  if (!lstatSync(workspace).isDirectory() || lstatSync(workspace).isSymbolicLink()) throw new Error("The teammate workspace is not available.");
  const root = realpathSync(workspace);

  let info: { id?: unknown; title?: unknown; duration?: unknown; uploader?: unknown; is_live?: unknown };
  try { info = JSON.parse(await run(tool, [...BASE, "--skip-download", "--dump-single-json", url], INFO_TIMEOUT_MS)); }
  catch (error) { if (error instanceof SyntaxError) throw new Error("The video details could not be read."); throw error; }
  const id = String(info.id ?? "");
  if (!/^[A-Za-z0-9_-]{4,24}$/.test(id)) throw new Error("The video could not be identified.");
  if (info.is_live) throw new Error("Live streams cannot be saved. Try again after it ends.");
  const seconds = typeof info.duration === "number" ? info.duration : 0;
  if (seconds > MAX_SECONDS) throw new Error("That video is longer than three hours.");

  const dir = path.join(root, "videos");
  if (existsSync(dir)) { if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error("The videos folder in this workspace is not usable."); }
  else mkdirSync(dir, { mode: 0o700 });
  if (!realpathSync(dir).startsWith(`${root}${path.sep}`)) throw new Error("The videos folder must be inside this workspace.");

  const file = path.join(dir, `${id}.mp4`);
  const transcript = path.join(dir, `${id}.transcript.txt`);
  const already = existsSync(file);
  if (!already) {
    await run(tool, [...BASE, "--max-filesize", MAX_FILE, "--restrict-filenames", "--no-mtime",
      "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]", "--merge-output-format", "mp4",
      "--write-subs", "--write-auto-subs", "--sub-langs", "en.*,en", "--sub-format", "vtt",
      "-o", path.join(dir, `${id}.%(ext)s`), url], DOWNLOAD_TIMEOUT_MS);
  }
  if (!existsSync(file) || statSync(file).size === 0) throw new Error("The video did not download. It may be private, removed, or too large.");

  let transcriptPath: string | null = existsSync(transcript) ? `videos/${id}.transcript.txt` : null;
  const captions = readdirSync(dir).filter((name) => name.startsWith(`${id}.`) && name.endsWith(".vtt")).sort();
  if (!transcriptPath && captions[0]) {
    const text = vttToTranscript(readFileSync(path.join(dir, captions[0]), "utf8"));
    if (text) { writeFileSync(transcript, text, { mode: 0o600, flag: "wx" }); transcriptPath = `videos/${id}.transcript.txt`; }
  }
  for (const name of captions) rmSync(path.join(dir, name), { force: true });

  return {
    saved: true, alreadyDownloaded: already, path: `videos/${id}.mp4`, transcriptPath,
    title: String(info.title ?? "").slice(0, 200), uploader: String(info.uploader ?? "").slice(0, 120), seconds: Math.round(seconds),
    instructions: transcriptPath
      ? "Read the transcript with workspace_read (it has [m:ss] times) before choosing moments. Use only video the owner has the right to reuse, and name the source in your answer."
      : "This video has no captions, so you cannot quote it exactly. Say so, and ask the owner for the key moments instead of guessing.",
  };
}
