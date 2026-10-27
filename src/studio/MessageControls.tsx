import { useState } from "react";
import { Check, Copy, MessageCircleReply, MessagesSquare, Pencil, RotateCcw, Share, SmilePlus, X } from "lucide-react";
import { ReadAloudButton } from "../components/Dictation";

/** Per-message contextual actions (U02c): reply, copy and the five
 * host-supported reactions. No message delete exists on this path by
 * design, so none is offered. Everything here maps to a real handler;
 * failures stay visible on the row instead of pretending success. */

export const MESSAGE_EMOJIS = ["👍", "❤️", "✅", "👀", "🎉"] as const;
export type MessageEmoji = (typeof MESSAGE_EMOJIS)[number];

export function MessageControls({ messageId, reactions, onReply, onReacted, readAloud, onRetry, onEdit, onShare, onThread }: {
  messageId: string;
  /** Ask the same teammate again (latest reply only). */
  onRetry?: () => void;
  onShare?: () => void;
  /** Open a side thread about this message. */
  onThread?: () => void;
  /** Put your latest message back in the box to adjust and resend. */
  onEdit?: () => void;
  /** A teammate reply that can be read aloud. */
  readAloud?: string;
  reactions: Array<{ emoji: string; count: number; reactedByYou: boolean }>;
  onReply: () => void;
  onReacted: () => void;
}) {
  const [reacting, setReacting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    setError("");
    const text = document.getElementById(`message-text-${messageId}`)?.innerText || "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Copy needs clipboard permission in this browser.");
    }
  }
  async function react(emoji: MessageEmoji) {
    setError("");
    try {
      const response = await fetch(`/api/messages/${encodeURIComponent(messageId)}/reactions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emoji }),
      });
      if (!response.ok) throw new Error("That reaction didn’t land. Try again.");
      setReacting(false);
      onReacted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That reaction didn’t land. Try again.");
    }
  }
  return (
    <span className="message-controls">
      <button type="button" className="message-control" aria-label="Reply to this message" title="Reply" onClick={onReply}>
        <MessageCircleReply size={15} />
      </button>
      {onThread && (
        <button type="button" className="message-control" aria-label="Reply in a thread" title="Reply in thread" onClick={onThread}>
          <MessagesSquare size={15} />
        </button>
      )}
      <button type="button" className="message-control" aria-label={copied ? "Copied" : "Copy message text"} title={copied ? "Copied" : "Copy"} onClick={() => void copy()}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
      {readAloud && <ReadAloudButton text={readAloud} className="message-control" />}
      {onRetry && <button type="button" className="message-control" aria-label="Try again" title="Try again" onClick={onRetry}><RotateCcw size={15} /></button>}
      {onShare && <button type="button" className="message-control" aria-label="Share this result" title="Share" onClick={onShare}><Share size={15} /></button>}
      {onEdit && <button type="button" className="message-control" aria-label="Edit and resend" title="Edit" onClick={onEdit}><Pencil size={15} /></button>}
      <button type="button" className="message-control" aria-label="React to this message" title="React" aria-expanded={reacting} onClick={() => { setReacting((open) => !open); setError(""); }}>
        {reacting ? <X size={15} /> : <SmilePlus size={15} />}
      </button>
      {reacting && (
        <span className="message-reactions" role="group" aria-label="Choose a reaction">
          {MESSAGE_EMOJIS.map((emoji) => (
            <button key={emoji} type="button" className="message-reaction" aria-label={`React ${emoji}`} onClick={() => void react(emoji)}>
              {emoji}
            </button>
          ))}
        </span>
      )}
      {reactions.length > 0 && (
        <span className="message-reaction-list" aria-label="Reactions">
          {reactions.map((reaction) => (
            <span key={reaction.emoji} className={`message-reaction-chip${reaction.reactedByYou ? " reacted" : ""}`} title={reaction.reactedByYou ? "You reacted" : undefined}>
              {reaction.emoji} {reaction.count}
            </span>
          ))}
        </span>
      )}
      {error && <span className="message-control-error" role="alert">{error}</span>}
    </span>
  );
}
