import path from "node:path";
import { execFile } from "node:child_process";
import { accessSync, constants, copyFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";

/** A finished short video from a list of scenes: clips or pictures from the
 * teammate's workspace (or a plain colour), a big caption on each, optional
 * voiceover and music. Same rules as the document and workbook exports:
 * sources stay inside the workspace, nothing is overwritten, the result is a
 * new file. ffmpeg runs without a shell and only with arguments built here. */

const MAX_SCENES = 30;
const MAX_TOTAL_SECONDS = 180;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 600 * 1024 * 1024;
/** Files shown in chat are limited to 25 MB; aim a little under it. */
const CHAT_TARGET_KILOBITS = 21 * 8 * 1024;
const AUDIO_KBPS = 128;
export const videoKbps = (seconds: number) => Math.max(1200, Math.min(6000, Math.floor(CHAT_TARGET_KILOBITS / Math.max(1, seconds)) - AUDIO_KBPS));
const STEP_TIMEOUT_MS = 5 * 60_000;

const VIDEO_EXT = /\.(?:mp4|m4v|mov|webm|mkv)$/i;
const IMAGE_EXT = /\.(?:png|jpe?g|webp)$/i;
const AUDIO_EXT = /\.(?:mp3|m4a|aac|wav|ogg|opus)$/i;

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #14141c.");
const relativePath = z.string().min(1).max(2048);

export const videoRenderInput = z.object({
  filename: z.string().max(160).regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*\.mp4$/, "Choose a new .mp4 filename without folders."),
  format: z.enum(["vertical", "square", "landscape"]).default("vertical"),
  background: color.default("#14141c"),
  accent: color.default("#ffd400"),
  scenes: z.array(z.object({
    source: relativePath.optional(),
    start: z.number().min(0).max(36_000).default(0),
    duration: z.number().min(0.5).max(30),
    caption: z.string().trim().min(1).max(160).optional(),
    highlight: z.string().trim().max(60).optional(),
    zoom: z.boolean().default(true),
    /** Fill the frame by cropping the sides. Off by default: a clip that does not match the frame is shown whole over a blurred copy of itself, so on-screen text is never cut. */
    crop: z.boolean().default(false),
  }).strict()).min(1).max(MAX_SCENES),
  voiceover: relativePath.optional(),
  music: relativePath.optional(),
  musicVolume: z.number().min(0).max(1).default(0.15),
}).strict();
export type VideoRenderInput = z.infer<typeof videoRenderInput>;

const SIZES = { vertical: [1080, 1920], square: [1080, 1080], landscape: [1920, 1080] } as const;

/** Finds a tool the way a shell would, plus the usual Homebrew folders that
 * a background service does not have on its PATH. */
export function findTool(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = [...(env.PATH || "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}
export const videoToolsAvailable = () => Boolean(findTool("ffmpeg"));

function resolveSource(root: string, relative: string, kind: "visual" | "audio"): string {
  const parts = relative.split(/[\\/]/);
  if (path.isAbsolute(relative) || parts.some((part) => !part || part.startsWith(".") || part === "..")) {
    throw new Error("Choose a visible file path relative to this teammate's workspace.");
  }
  const allowed = kind === "audio" ? AUDIO_EXT.test(relative) : VIDEO_EXT.test(relative) || IMAGE_EXT.test(relative);
  if (!allowed) throw new Error(kind === "audio" ? "Audio must be .mp3, .m4a, .aac, .wav, .ogg or .opus." : "Scenes can use .mp4, .mov, .m4v, .webm, .mkv, .png, .jpg or .webp files.");
  let target = root;
  for (const part of parts) {
    target = path.join(target, part);
    let info;
    try { info = lstatSync(target); } catch { throw new Error(`The file ${relative} was not found in this workspace.`); }
    if (info.isSymbolicLink()) throw new Error("Video sources cannot use symbolic links.");
  }
  if (!realpathSync(target).startsWith(`${root}${path.sep}`)) throw new Error("The source must be inside this workspace.");
  const info = statSync(target);
  if (!info.isFile() || info.size === 0 || info.size > MAX_SOURCE_BYTES) throw new Error(`${relative} must be a regular, non-empty file under 4 GiB.`);
  return target;
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Word-wrap by an estimate of bold glyph width; the caption is a picture. */
function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > maxChars) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

export async function captionPng(text: string, highlight: string | undefined, width: number, height: number, accent: string, centered: boolean): Promise<Buffer> {
  const size = Math.round(Math.min(width, height) * (width > height ? 0.085 : 0.082));
  const maxChars = Math.max(8, Math.floor((width * 0.86) / (size * 0.6)));
  const lines = wrap(text, maxChars);
  const marked = new Set((highlight || "").toLowerCase().split(/\s+/).map((word) => word.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean));
  const lineHeight = Math.round(size * 1.18);
  const block = lineHeight * lines.length;
  const bottom = centered ? (height + block) / 2 - (lineHeight - size) : height * (width > height ? 0.9 : 0.84);
  const firstBaseline = bottom - block + lineHeight - (lineHeight - size) / 2;
  const font = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="800" font-size="${size}" text-anchor="middle" stroke="#000" stroke-width="${Math.round(size * 0.11)}" stroke-linejoin="round" paint-order="stroke"`;
  const rows = lines.map((line, index) => {
    const words = line.split(" ").map((word, position) => {
      const plain = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      const fill = marked.has(plain) ? accent : "#ffffff";
      return `<tspan fill="${fill}">${escapeXml(word)}${position < line.split(" ").length - 1 ? " " : ""}</tspan>`;
    }).join("");
    return `<text x="${width / 2}" y="${Math.round(firstBaseline + index * lineHeight)}" ${font} xml:space="preserve">${words}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rows}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

type Run = (file: string, args: string[]) => Promise<void>;
const runTool: Run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: STEP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "" } }, (error, _stdout, stderr) => {
    if (!error) return resolve();
    const detail = String(stderr || "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
    reject(new Error((error as { killed?: boolean }).killed ? "Rendering took too long and was stopped. Use fewer or shorter scenes." : `Video rendering failed. ${detail}`.trim()));
  });
});

export type Size = { w: number; h: number };
/** Width and height of a clip or picture, or null when ffprobe is missing. */
export async function probeSize(file: string): Promise<Size | null> {
  const ffprobe = findTool("ffprobe");
  if (!ffprobe) return null;
  return new Promise((resolve) => {
    execFile(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file], { timeout: 30_000 }, (error, stdout) => {
      const match = !error && /^(\d{2,5})x(\d{2,5})/.exec(String(stdout).trim());
      resolve(match ? { w: Number(match[1]), h: Number(match[2]) } : null);
    });
  });
}
/** The size a source takes when shown whole inside the frame, or null when it
 * already matches the frame closely enough to fill it. */
export function fitBox(source: Size | null, width: number, height: number): Size | null {
  if (!source) return null;
  const ratio = (source.w / source.h) / (width / height);
  if (Math.abs(ratio - 1) <= 0.05) return null;
  const scale = Math.min(width / source.w, height / source.h);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { w: even(source.w * scale), h: even(source.h * scale) };
}

export function sceneArgs(input: { width: number; height: number; background: string; scene: VideoRenderInput["scenes"][number]; source?: string; caption?: string; out: string; kbps?: number; fit?: Size | null }): string[] {
  const { width: w, height: h, scene, source, caption, out } = input;
  const kbps = input.kbps ?? 4000;
  const d = scene.duration;
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
  if (source && VIDEO_EXT.test(source)) args.push("-ss", String(scene.start), "-t", String(d), "-i", source);
  else if (source) args.push("-loop", "1", "-t", String(d), "-i", source);
  else args.push("-f", "lavfi", "-i", `color=c=0x${input.background.slice(1)}:s=${w}x${h}:r=30:d=${d}`);
  // Looped for the whole scene so the fade-in has frames to fade across.
  if (caption) args.push("-loop", "1", "-framerate", "30", "-t", String(d), "-i", caption);
  const fit = source ? input.fit : null;
  let base: string;
  if (fit) {
    // The whole picture, centred over a darkened, blurred copy that fills the
    // frame. The slow zoom grows the picture from 94% to 100% of its box.
    const scaleAt = `(0.94+0.06*t/${d})`;
    const front = scene.zoom
      ? `scale=w='trunc(${fit.w}*${scaleAt}/2)*2':h='trunc(${fit.h}*${scaleAt}/2)*2':eval=frame`
      : `scale=${fit.w}:${fit.h}`;
    base = `[0:v]setsar=1,fps=30,split=2[a][b];[a]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=40,eq=brightness=-0.12[blur];[b]${front}[front];[blur][front]overlay=x='(W-w)/2':y='(H-h)/2':eval=frame:format=auto,format=yuv420p`;
  } else {
    const zoom = scene.zoom && source ? `,scale=w='${w}*(1+0.06*t/${d})':h='${h}*(1+0.06*t/${d})':eval=frame,crop=${w}:${h}` : "";
    base = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=30${zoom},format=yuv420p`;
  }
  const graph = caption
    ? `${base}[bg];[1:v]format=rgba,fade=t=in:st=0:d=0.25:alpha=1[cap];[bg][cap]overlay=0:0:format=auto,format=yuv420p[v]`
    : `${base}[v]`;
  args.push("-filter_complex", graph, "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p", "-r", "30", "-t", String(d), out);
  return args;
}

export async function renderVideo(workspace: string, args: unknown, run: Run = runTool) {
  const input = videoRenderInput.parse(args);
  const total = input.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  if (total > MAX_TOTAL_SECONDS) throw new Error(`The video would be ${Math.round(total)} seconds. Keep it under ${MAX_TOTAL_SECONDS}.`);
  const ffmpeg = findTool("ffmpeg");
  if (!ffmpeg) throw new Error("Video tools are not installed on this Mac. Install ffmpeg (for example with Homebrew: brew install ffmpeg), then try again.");
  if (!lstatSync(workspace).isDirectory() || lstatSync(workspace).isSymbolicLink()) throw new Error("The teammate workspace is not available.");
  const root = realpathSync(workspace);
  const target = path.join(root, input.filename);
  try { lstatSync(target); throw new Error("That video already exists. Choose a new filename; existing files are never replaced."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  const [width, height] = SIZES[input.format];
  const sources = input.scenes.map((scene) => scene.source ? resolveSource(root, scene.source, "visual") : undefined);
  const voiceover = input.voiceover ? resolveSource(root, input.voiceover, "audio") : undefined;
  const music = input.music ? resolveSource(root, input.music, "audio") : undefined;

  const temp = mkdtempSync(path.join(tmpdir(), "sidemates-video-"));
  try {
    const segments: string[] = [];
    for (const [index, scene] of input.scenes.entries()) {
      let caption: string | undefined;
      if (scene.caption) {
        caption = path.join(temp, `caption-${index}.png`);
        writeFileSync(caption, await captionPng(scene.caption, scene.highlight, width, height, input.accent, !sources[index]));
      }
      const out = path.join(temp, `scene-${index}.mp4`);
      const fit = sources[index] && !scene.crop ? fitBox(await probeSize(sources[index]!), width, height) : null;
      await run(ffmpeg, sceneArgs({ width, height, background: input.background, scene, source: sources[index], caption, out, kbps: videoKbps(total), fit }));
      segments.push(out);
    }
    const list = path.join(temp, "scenes.txt");
    writeFileSync(list, segments.map((segment) => `file '${segment.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
    const silent = path.join(temp, "video.mp4");
    await run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent]);

    const final = path.join(temp, "final.mp4");
    if (voiceover || music) {
      const mux = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", silent];
      if (voiceover) mux.push("-i", voiceover);
      if (music) mux.push("-stream_loop", "-1", "-i", music);
      const voiceIndex = voiceover ? 1 : -1, musicIndex = music ? (voiceover ? 2 : 1) : -1;
      const fade = Math.max(0, total - 1.5);
      const parts: string[] = [];
      if (voiceover) parts.push(`[${voiceIndex}:a]apad,atrim=0:${total},asetpts=N/SR/TB[voice]`);
      if (music) parts.push(`[${musicIndex}:a]atrim=0:${total},asetpts=N/SR/TB,volume=${input.musicVolume},afade=t=out:st=${fade}:d=1.5[music]`);
      parts.push(voiceover && music ? "[voice][music]amix=inputs=2:duration=longest:normalize=0[a]" : `[${voiceover ? "voice" : "music"}]anull[a]`);
      mux.push("-filter_complex", parts.join(";"), "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-t", String(total), "-movflags", "+faststart", final);
      await run(ffmpeg, mux);
    } else {
      await run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", silent, "-c", "copy", "-movflags", "+faststart", final]);
    }
    const bytes = statSync(final).size;
    if (bytes > MAX_OUTPUT_BYTES) throw new Error("The finished video is too large. Use fewer or shorter scenes.");
    try { copyFileSync(final, target, constants.COPYFILE_EXCL); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("That video already exists. Choose a new filename; existing files are never replaced.");
      throw error;
    }
    const sha256 = createHash("sha256").update(readFileSync(target)).digest("hex");
    return {
      saved: true, path: input.filename, bytes, fitsInChat: bytes <= 25 * 1024 * 1024, sha256, seconds: Math.round(total * 10) / 10, scenes: input.scenes.length, format: input.format, size: `${width}x${height}`,
      instructions: "Link the .mp4 in your final answer and say what it contains. If fitsInChat is false it is saved in the workspace but too big to show in chat, so say where it is. This was rendered from the scenes you listed; check the first and last scene against the source before calling it final.",
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
