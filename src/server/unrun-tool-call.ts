/** Some models write a tool call as plain text instead of making it. The job
 * then reads as finished while nothing happened. This spots that markup in a
 * final answer so the job can be marked failed instead of done. Code blocks
 * are ignored, since an answer may legitimately show this syntax. */
const MARKUP = [
  /<[^<>\n]{0,8}DSML[^<>\n]{0,8}(?:tool_calls|function_calls|invoke)/i,
  /<function_calls>/i,
  /<invoke\s+name=/i,
  /<tool_call>/i,
  /<\|tool_call/i,
  /<tool_use>/i,
];

export function looksLikeUnrunToolCall(text: string): boolean {
  const outsideCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return MARKUP.some((pattern) => pattern.test(outsideCode));
}

export const UNRUN_TOOL_CALL_ERROR = "The teammate wrote out a tool call instead of using it, so nothing was actually done. Sidemates has not marked this job finished. Try again, or pick a different AI for this teammate.";
