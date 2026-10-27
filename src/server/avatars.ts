import path from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";

/** A teammate's own picture. The upload is decoded and re-encoded here, never
 * served as sent: it becomes a 256x256 square WebP with no metadata (location,
 * camera, embedded scripts or profiles), so only pixels we produced are shown. */

export const MAX_AVATAR_BYTES = 6 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const FORMATS = new Set(["jpeg", "png", "webp", "gif", "avif", "heif", "tiff"]);
export const AVATAR_SIZE = 256;

const fileKey = (botId: string) => /^[A-Za-z0-9_-]{1,80}$/.test(botId) ? botId : createHash("sha256").update(botId).digest("hex").slice(0, 40);
export const avatarFile = (dataDir: string, botId: string) => path.join(dataDir, "avatars", `${fileKey(botId)}.webp`);

export async function saveAvatar(dataDir: string, botId: string, bytes: Buffer): Promise<string> {
  if (bytes.length === 0) throw new Error("Choose a picture that is not empty.");
  if (bytes.length > MAX_AVATAR_BYTES) throw new Error("That picture is larger than 6 MB. Choose a smaller one.");
  let image: ReturnType<typeof sharp>;
  try {
    image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false });
    const meta = await image.metadata();
    if (!meta.format || !FORMATS.has(meta.format)) throw new Error("unsupported");
    if (!meta.width || !meta.height) throw new Error("empty");
  } catch {
    throw new Error("Choose a JPG, PNG, WebP or GIF picture.");
  }
  let output: Buffer;
  try {
    // rotate() applies the camera's orientation before the metadata is dropped.
    output = await image.rotate().resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "attention" }).webp({ quality: 86 }).toBuffer();
  } catch {
    throw new Error("That picture could not be read. Try saving it again as a JPG or PNG.");
  }
  const dir = path.join(dataDir, "avatars");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = avatarFile(dataDir, botId), temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, output, { mode: 0o600 });
  renameSync(temp, target);
  try { chmodSync(target, 0o600); } catch { /* best effort */ }
  // The version changes with every picture, so browsers refetch exactly then.
  return createHash("sha256").update(output).digest("hex").slice(0, 16);
}

export function readAvatar(dataDir: string, botId: string): Buffer | null {
  const file = avatarFile(dataDir, botId);
  return existsSync(file) ? readFileSync(file) : null;
}

export function removeAvatar(dataDir: string, botId: string) {
  rmSync(avatarFile(dataDir, botId), { force: true });
}
