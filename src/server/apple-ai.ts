import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Bot, Message } from "../shared/types.js";
import { teammateSystemPrompt } from "./workspace.js";

/** Apple's built-in AI (Apple Intelligence): free, private and offline. A
 * Mac with no AI account still gets a team that can talk, draft and think
 * things through. It has a small memory and no tools here, so it is always
 * the last choice: Automatic AI only uses it when it's the only AI, or when
 * the others have run out. The bridge is a tiny Swift program
 * (native/apple-ai/AppleAI.swift) built next to Sidemates. */

export const APPLE_MODEL = "apple/on-device";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type Runner = (helper: string, input: string, timeoutMs: number) => Promise<string>;
const runHelper: Runner = (helper, input, timeoutMs) => new Promise((resolve, reject) => {
  const child = execFile(helper, [], { timeout: timeoutMs, maxBuffer: 1_000_000 }, (error, stdout) => error && !stdout ? reject(error) : resolve(stdout));
  child.stdin?.end(input);
});

/** The helper, wherever this copy of Sidemates keeps it: built into the
 * Mac app's bin folder (on PATH), or the checkout's own bin folder. */
export function appleAiHelper(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): string | null {
  if (env.OPENBOT_APPLE_AI && exists(env.OPENBOT_APPLE_AI)) return env.OPENBOT_APPLE_AI;
  for (const dir of [path.join(rootDir, "bin"), ...(env.PATH || "").split(path.delimiter).filter(Boolean)]) {
    const candidate = path.join(dir, "apple-ai");
    if (exists(candidate)) return candidate;
  }
  return null;
}

export type AppleAiStatus = { installed: boolean; available: boolean; reason: string };

/** Whether Apple Intelligence can answer on this Mac. Quick; never throws. */
export async function appleAiStatus(platform: NodeJS.Platform = process.platform, helper = appleAiHelper(), run: Runner = runHelper): Promise<AppleAiStatus> {
  if (platform !== "darwin" || !helper) return { installed: false, available: false, reason: "Apple's built-in AI needs a Mac with Apple Intelligence." };
  try {
    const answer = JSON.parse(await run(helper, JSON.stringify({ mode: "status" }), 15_000)) as { available?: boolean; reason?: string };
    return { installed: true, available: answer.available === true, reason: answer.reason || "" };
  } catch {
    return { installed: true, available: false, reason: "Apple's built-in AI didn't answer." };
  }
}

/** One answer from Apple's on-device model, or an error in plain words. */
export async function respondOnApple(input: { instructions: string; prompt: string }, helper = appleAiHelper(), run: Runner = runHelper): Promise<string> {
  if (!helper) throw new Error("Apple's built-in AI isn't set up in this copy of Sidemates.");
  let raw: string;
  try { raw = await run(helper, JSON.stringify({ mode: "respond", ...input }), 120_000); }
  catch { throw new Error("Apple's built-in AI didn't answer in time. Try again, or connect ChatGPT, Claude or Gemini for bigger jobs."); }
  const answer = JSON.parse(raw) as { text?: string; error?: string; code?: string };
  if (typeof answer.text === "string" && answer.text.trim()) return answer.text.trim();
  if (answer.code === "too_long") throw new Error("This is too long for Apple's built-in AI. Connect ChatGPT, Claude or Gemini for bigger jobs.");
  throw new Error(answer.error || "Apple's built-in AI couldn't answer this.");
}

/** What Apple's model is told: who the teammate is, and the honest limits of
 * running without tools. Short, because its memory is small. */
export function appleInstructions(bot: Pick<Bot, "name" | "role" | "instructions">): string {
  const own = (bot.instructions || "").replace(/\s+/g, " ").trim().slice(0, 600);
  return [
    teammateSystemPrompt(bot as Bot),
    `Your job: ${bot.role}.`,
    own && own !== bot.role ? `Owner's notes for you: ${own}` : "",
    "You're running on Apple's built-in AI on this Mac: private and free, but without tools. You can't read mail, calendars, notes, files or websites, and you can't send, save, schedule or change anything.",
    "Answer from the conversation alone. If the request needs any of those things, say so in one sentence and suggest connecting ChatGPT, Claude or Gemini in Sidemates (Workspace, then Your AI). Never claim you did something, and don't offer to do what you can't here (sending, saving, archiving, scheduling).",
    "Talk like a helpful colleague in a chat: short, warm and specific.",
  ].filter(Boolean).join("\n");
}

/** The request with a little recent conversation, kept small. */
export function applePrompt(history: Pick<Message, "senderType" | "senderName" | "body" | "kind">[], request: string): string {
  const recent = history.filter((message) => message.kind === "text" && message.body.trim()).slice(-6)
    .map((message) => `${message.senderType === "user" ? "Owner" : message.senderName || "Teammate"}: ${message.body.replace(/\s+/g, " ").slice(0, 400)}`);
  const ask = request.trim().slice(0, 4_000);
  if (recent.at(-1)?.endsWith(ask.replace(/\s+/g, " ").slice(0, 400))) recent.pop();
  return [recent.length ? `Recent conversation:\n${recent.join("\n")}` : "", `The owner asks: ${ask}`].filter(Boolean).join("\n\n");
}
