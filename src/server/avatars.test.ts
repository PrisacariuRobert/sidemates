import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { avatarFile, MAX_AVATAR_BYTES, readAvatar, removeAvatar, saveAvatar } from "./avatars.js";

const dir = () => mkdtempSync(path.join(tmpdir(), "avatars-"));
const photo = (width: number, height: number, format: "png" | "jpeg" = "png") => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } })[format]().toBuffer();

test("a picture becomes a 256x256 WebP, whatever it was sent as", async () => {
  const data = dir();
  const version = await saveAvatar(data, "nova", await photo(1200, 700, "jpeg"));
  assert.match(version, /^[0-9a-f]{16}$/);
  const stored = readAvatar(data, "nova")!;
  const meta = await sharp(stored).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 256, 256]);
  assert.equal(statSync(avatarFile(data, "nova")).mode & 0o077, 0, "only the owner can read the file");
  assert.equal(readdirSync(path.join(data, "avatars")).length, 1, "no temp files are left behind");
  const next = await saveAvatar(data, "nova", await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123456" } }).png().toBuffer());
  assert.notEqual(next, version, "a different picture has a different version");
});

test("hidden photo data such as location is not kept", async () => {
  const data = dir();
  const tagged = await sharp(await photo(400, 400, "jpeg")).withExif({ IFD0: { Copyright: "secret-owner" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "48/1 12/1 0/1" } }).jpeg().toBuffer();
  assert.ok((await sharp(tagged).metadata()).exif, "the test picture really carries EXIF");
  await saveAvatar(data, "nova", tagged);
  const stored = readAvatar(data, "nova")!;
  assert.equal((await sharp(stored).metadata()).exif, undefined);
  assert.ok(!stored.includes(Buffer.from("secret-owner")));
});

test("anything that is not a normal picture is refused", async () => {
  const data = dir();
  await assert.rejects(saveAvatar(data, "nova", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")), /JPG, PNG, WebP or GIF/);
  await assert.rejects(saveAvatar(data, "nova", Buffer.from("just some text")), /JPG, PNG, WebP or GIF/);
  await assert.rejects(saveAvatar(data, "nova", Buffer.alloc(0)), /not empty/);
  await assert.rejects(saveAvatar(data, "nova", Buffer.alloc(MAX_AVATAR_BYTES + 1)), /larger than 6 MB/);
  const huge = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer();
  await assert.rejects(saveAvatar(data, "nova", huge), /JPG, PNG, WebP or GIF|could not be read/);
  assert.equal(existsSync(avatarFile(data, "nova")), false, "nothing is stored for a refused picture");
});

test("a picture is removed on request, and odd ids cannot escape the folder", async () => {
  const data = dir();
  await saveAvatar(data, "pixel", await photo(100, 100));
  removeAvatar(data, "pixel");
  assert.equal(readAvatar(data, "pixel"), null);
  const weird = avatarFile(data, "../../etc/passwd");
  assert.equal(path.dirname(weird), path.join(data, "avatars"));
  await saveAvatar(data, "../../etc/passwd", await photo(100, 100));
  assert.ok(readAvatar(data, "../../etc/passwd"));
});
