import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkVideoUrl, fetchVideo, vttToTranscript } from "./video-fetch.js";
import { findTool } from "./video-render.js";

test("only plain https YouTube and Vimeo links can be saved", () => {
  for (const ok of ["https://www.youtube.com/watch?v=abcdefghijk", "https://youtu.be/abcdefghijk", "https://m.youtube.com/watch?v=abcdefghijk", "https://vimeo.com/123456789"]) assert.doesNotThrow(() => checkVideoUrl(ok), ok);
  for (const bad of [
    "http://www.youtube.com/watch?v=abcdefghijk", "https://evil.com/youtube.com", "https://youtube.com.evil.com/x", "https://user:pw@youtube.com/x",
    "https://127.0.0.1/video.mp4", "https://localhost/x", "https://192.168.1.5:8080/x", "https://www.youtube.com:8443/x", "file:///etc/passwd", "ftp://youtu.be/x", "https://169.254.169.254/latest/meta-data",
  ]) assert.throws(() => checkVideoUrl(bad), Error, bad);
});

test("captions become a timed transcript without the scrolling repeats", () => {
  const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOn Christmas Eve 2002,\n\n00:00:03.000 --> 00:00:04.000\nOn Christmas Eve 2002,\n\n00:01:05.500 --> 00:01:08.000 align:start\n<c>Scott</c> &amp; Laci <00:01:06.000>went\n\n01:02:03.000 --> 01:02:05.000\nLate line\n`;
  assert.equal(vttToTranscript(vtt), "[0:01] On Christmas Eve 2002,\n[1:05] Scott & Laci went\n[62:03] Late line");
});

test("a video and its transcript land in the workspace, once", { skip: !findTool("yt-dlp") }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "video-fetch-"));
  const calls: string[][] = [];
  const fake = async (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes("--dump-single-json")) return JSON.stringify({ id: "abcdefghijk", title: "A title", duration: 600, uploader: "Someone" });
    const out = args[args.indexOf("-o") + 1]!.replace("%(ext)s", "mp4");
    writeFileSync(out, "video");
    writeFileSync(out.replace(/\.mp4$/, ".en.vtt"), "WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nHello there\n");
    return "";
  };
  const first = await fetchVideo(dir, { url: "https://youtu.be/abcdefghijk" }, fake);
  assert.equal(first.path, "videos/abcdefghijk.mp4"); assert.equal(first.transcriptPath, "videos/abcdefghijk.transcript.txt"); assert.equal(first.alreadyDownloaded, false);
  assert.equal(readFileSync(path.join(dir, first.transcriptPath!), "utf8"), "[0:02] Hello there");
  assert.equal(existsSync(path.join(dir, "videos", "abcdefghijk.en.vtt")), false, "raw caption file is removed");
  const download = calls.find((args) => args.includes("-o"))!;
  assert.ok(download.includes("--use-extractors") && download[download.indexOf("--use-extractors") + 1] === "youtube,vimeo");
  assert.ok(download.includes("--ignore-config") && download.includes("--no-playlist"));
  const again = await fetchVideo(dir, { url: "https://youtu.be/abcdefghijk" }, fake);
  assert.equal(again.alreadyDownloaded, true);
  assert.equal(calls.filter((args) => args.includes("-o")).length, 1, "an existing video is not downloaded again");
});

test("live streams, very long videos and odd ids are refused", { skip: !findTool("yt-dlp") }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "video-fetch-"));
  const info = (value: object) => async () => JSON.stringify(value);
  await assert.rejects(fetchVideo(dir, { url: "https://youtu.be/abcdefghijk" }, info({ id: "abcdefghijk", is_live: true })), /Live streams/);
  await assert.rejects(fetchVideo(dir, { url: "https://youtu.be/abcdefghijk" }, info({ id: "abcdefghijk", duration: 99_999 })), /three hours/);
  await assert.rejects(fetchVideo(dir, { url: "https://youtu.be/abcdefghijk" }, info({ id: "../../etc/passwd" })), /could not be identified/);
});
