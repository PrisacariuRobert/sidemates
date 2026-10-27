import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { captionPng, findTool, fitBox, renderVideo, sceneArgs, videoKbps, videoRenderInput } from "./video-render.js";

const workspace = () => { const dir = mkdtempSync(path.join(tmpdir(), "video-ws-")); return dir; };
const scene = { duration: 2, start: 0, zoom: true, crop: false };
const noRun = async () => { throw new Error("ffmpeg must not run for an invalid request"); };

test("a render request is bounded and only creates a new .mp4", () => {
  assert.equal(videoRenderInput.safeParse({ filename: "../x.mp4", scenes: [scene] }).success, false);
  assert.equal(videoRenderInput.safeParse({ filename: "short.mov", scenes: [scene] }).success, false);
  assert.equal(videoRenderInput.safeParse({ filename: "short.mp4", scenes: [] }).success, false);
  assert.equal(videoRenderInput.safeParse({ filename: "short.mp4", scenes: [{ ...scene, duration: 31 }] }).success, false);
  assert.equal(videoRenderInput.safeParse({ filename: "short.mp4", accent: "red", scenes: [scene] }).success, false);
  assert.equal(videoRenderInput.safeParse({ filename: "short.mp4", scenes: [scene], extra: 1 }).success, false);
  const ok = videoRenderInput.parse({ filename: "short.mp4", scenes: [{ duration: 3, caption: "Hello" }] });
  assert.equal(ok.format, "vertical"); assert.equal(ok.scenes[0]!.zoom, true);
});

test("sources stay inside the workspace and totals stay under three minutes", { skip: !findTool("ffmpeg") }, async () => {
  const dir = workspace();
  const outside = mkdtempSync(path.join(tmpdir(), "video-outside-"));
  writeFileSync(path.join(outside, "secret.mp4"), "x");
  symlinkSync(outside, path.join(dir, "link"));
  writeFileSync(path.join(dir, ".hidden.mp4"), "x");
  const req = (source: string) => ({ filename: "out.mp4", scenes: [{ ...scene, source }] });
  await assert.rejects(renderVideo(dir, req("../secret.mp4"), noRun), /relative to this teammate's workspace/);
  await assert.rejects(renderVideo(dir, req("/etc/passwd.mp4"), noRun), /relative to this teammate's workspace/);
  await assert.rejects(renderVideo(dir, req(".hidden.mp4"), noRun), /relative to this teammate's workspace/);
  await assert.rejects(renderVideo(dir, req("link/secret.mp4"), noRun), /symbolic links/);
  await assert.rejects(renderVideo(dir, req("notes.txt"), noRun), /Scenes can use/);
  await assert.rejects(renderVideo(dir, req("missing.mp4"), noRun), /was not found/);
  const long = { filename: "out.mp4", scenes: Array.from({ length: 7 }, () => ({ ...scene, duration: 30 })) };
  await assert.rejects(renderVideo(dir, long, noRun), /under 180/);
  writeFileSync(path.join(dir, "taken.mp4"), "x");
  await assert.rejects(renderVideo(dir, { filename: "taken.mp4", scenes: [scene] }, noRun), /already exists/);
});

test("captions are drawn as a picture of the right size", async () => {
  const png = await captionPng("HE SAID HE WENT FISHING.", "fishing", 1080, 1920, "#ffd400", false);
  assert.deepEqual([png[0], png[1], png[2], png[3]], [0x89, 0x50, 0x4e, 0x47]);
  const wide = await captionPng("Plain <b> & \"quotes\" are escaped", undefined, 1920, 1080, "#ffd400", true);
  assert.ok(wide.length > 100);
});

test("each scene is cut, scaled to the frame and captioned with arguments, not a shell string", () => {
  const args = sceneArgs({ width: 1080, height: 1920, background: "#14141c", scene: { ...scene, source: undefined }, caption: "/tmp/c.png", out: "/tmp/o.mp4" });
  assert.ok(args.join(" ").includes("color=c=0x14141c:s=1080x1920"));
  assert.ok(args.includes("-filter_complex") && args.includes("/tmp/o.mp4"));
  const clip = sceneArgs({ width: 1080, height: 1920, background: "#14141c", scene: { ...scene, start: 12.5 }, source: "/w/a.mp4", out: "/tmp/o.mp4" });
  assert.deepEqual(clip.slice(clip.indexOf("-ss"), clip.indexOf("-ss") + 5), ["-ss", "12.5", "-t", "2", "-i"]);
});

test("a real short is rendered with captions, voice-free music and the right length", { skip: !findTool("ffmpeg") || !findTool("ffprobe"), timeout: 120_000 }, async () => {
  const dir = workspace();
  const ffmpeg = findTool("ffmpeg")!;
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "clip.mp4")]);
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=330:d=2", path.join(dir, "bed.wav")]);
  mkdirSync(path.join(dir, "media"));
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=640x360:d=1", "-frames:v", "1", path.join(dir, "media", "card.png")]);
  const result = await renderVideo(dir, {
    filename: "short.mp4",
    scenes: [
      { duration: 1.5, caption: "He said he went fishing", highlight: "fishing" },
      { source: "clip.mp4", start: 1, duration: 2, caption: "The evidence said otherwise" },
      { source: "media/card.png", duration: 1, zoom: false },
    ],
    music: "bed.wav", musicVolume: 0.2,
  });
  assert.equal(result.saved, true); assert.equal(result.size, "1080x1920"); assert.equal(result.seconds, 4.5);
  const file = path.join(dir, "short.mp4");
  assert.ok(existsSync(file));
  const probe = execFileSync(findTool("ffprobe")!, ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-show_entries", "format=duration", "-of", "json", file], { encoding: "utf8" });
  const info = JSON.parse(probe) as { streams: Array<{ codec_type: string; width?: number; height?: number }>; format: { duration: string } };
  const video = info.streams.find((stream) => stream.codec_type === "video")!;
  assert.deepEqual([video.width, video.height], [1080, 1920]);
  assert.ok(info.streams.some((stream) => stream.codec_type === "audio"), "music is mixed in");
  assert.ok(Math.abs(Number(info.format.duration) - 4.5) < 0.4, `duration ${info.format.duration}`);
  // The caption must really be in the picture: bright text pixels in the lower
  // part of the text-only first scene, none in the same area before the fade.
  const frame = async (second: number) => {
    const out = path.join(dir, `frame-${second}.png`);
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(second), "-i", file, "-frames:v", "1", out]);
    return (await sharp(out).extract({ left: 0, top: 1300, width: 1080, height: 400 }).stats()).channels[0]!.max;
  };
  assert.equal(await frame(1.2), 255, "caption is visible during its scene");
  assert.ok(await frame(0) < 255, "caption fades in from nothing");
  await assert.rejects(renderVideo(dir, { filename: "short.mp4", scenes: [{ duration: 1 }] }), /already exists/);
});

test("the bitrate is capped so a normal short fits the 25 MB chat limit", () => {
  const size = (seconds: number) => (videoKbps(seconds) + 128) * seconds / 8 / 1024;
  for (const seconds of [15, 45, 59, 90]) assert.ok(size(seconds) < 24, `${seconds}s is about ${size(seconds).toFixed(1)} MB`);
  assert.equal(videoKbps(5), 6000);
  assert.equal(videoKbps(180), 1200);
});

test("a clip that does not match the frame is shown whole, not cropped", () => {
  assert.deepEqual(fitBox({ w: 1920, h: 1080 }, 1080, 1920), { w: 1080, h: 608 });
  assert.deepEqual(fitBox({ w: 1080, h: 1920 }, 1920, 1080), { w: 608, h: 1080 });
  assert.equal(fitBox({ w: 1080, h: 1920 }, 1080, 1920), null, "a matching clip fills the frame");
  assert.equal(fitBox({ w: 1100, h: 1920 }, 1080, 1920), null, "close enough fills the frame");
  assert.equal(fitBox(null, 1080, 1920), null, "unknown size falls back to filling");
  const args = sceneArgs({ width: 1080, height: 1920, background: "#14141c", scene: { ...scene, source: undefined }, source: "/w/a.mp4", out: "/tmp/o.mp4", fit: { w: 1080, h: 608 } });
  const graph = args[args.indexOf("-filter_complex") + 1]!;
  assert.ok(graph.includes("gblur") && graph.includes("overlay=x='(W-w)/2'"), graph);
  assert.ok(graph.includes("0.94+0.06*t/2"), "the picture grows from 94% to 100% of its box");
  const filled = sceneArgs({ width: 1080, height: 1920, background: "#14141c", scene, source: "/w/a.mp4", out: "/tmp/o.mp4", fit: null });
  assert.ok(!filled[filled.indexOf("-filter_complex") + 1]!.includes("gblur"));
});

test("wide footage keeps its left and right edges in a vertical video", { skip: !findTool("ffmpeg") || !findTool("ffprobe"), timeout: 120_000 }, async () => {
  const dir = workspace();
  const ffmpeg = findTool("ffmpeg")!;
  // Red bars on the far left and right edges of a wide clip: cropping would lose them.
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x303030:s=1920x1080:r=30:d=3", "-vf", "drawbox=x=0:y=0:w=160:h=1080:color=red:t=fill,drawbox=x=1760:y=0:w=160:h=1080:color=lime:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "wide.mp4")]);
  const frameOf = async (name: string, request: object) => {
    await renderVideo(dir, { filename: name, ...request });
    const png = path.join(dir, `${name}.png`);
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", "0.2", "-i", path.join(dir, name), "-frames:v", "1", png]);
    return sharp(png).raw().toBuffer({ resolveWithObject: true });
  };
  const at = (frame: { data: Buffer; info: { width: number; channels: number } }, x: number, y: number) => { const i = (y * frame.info.width + x) * frame.info.channels; return [frame.data[i]!, frame.data[i + 1]!, frame.data[i + 2]!]; };
  const fitted = await frameOf("fit.mp4", { scenes: [{ source: "wide.mp4", duration: 1, zoom: false }] });
  const left = at(fitted, 10, 960), right = at(fitted, 1069, 960);
  assert.ok(left[0]! > 180 && left[1]! < 80, `left edge kept (red): ${left}`);
  assert.ok(right[1]! > 180 && right[0]! < 80, `right edge kept (green): ${right}`);
  const cropped = await frameOf("crop.mp4", { scenes: [{ source: "wide.mp4", duration: 1, zoom: false, crop: true }] });
  const lost = at(cropped, 10, 960);
  assert.ok(!(lost[0]! > 180 && lost[1]! < 80), `crop: true loses the edge: ${lost}`);
});
