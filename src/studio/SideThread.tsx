import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, LoaderCircle, X } from "lucide-react";
import { MarkdownMessage } from "../MarkdownMessage";
import type { Message } from "../shared/types";

/** A conversation beside the main chat about one message: the message on top,
 * the follow-ups under it, a box to ask more. The main chat stays clean; it
 * only shows how many replies a message has. */

const timeText = (date: string) => new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function SideThread({ root, replies, working, face, onSend, onClose }: {
  root: Message;
  replies: Message[];
  /** Names of teammates still working on a reply in this thread. */
  working: string[];
  face: (message: Message) => ReactNode;
  onSend: (body: string) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const shown = replies.filter((message) => message.kind === "text");
  // Status lines (a stopped or failed run) stay visible inside the thread too.
  const timeline = replies.filter((message) => message.kind === "text" || message.eventType === "run_stopped");
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [timeline.length, working.length]);
  useEffect(() => { box.current?.focus(); }, [root.id]);
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true); setError("");
    try { await onSend(body); setDraft(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "That did not send. Try again."); }
    finally { setBusy(false); box.current?.focus(); }
  }
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  };
  return (
    <>
      <header>
        <h2>Thread</h2>
        <button type="button" aria-label="Close thread" onClick={onClose}><X size={19} /></button>
      </header>
      <div className="side-thread-body">
        <article className="side-thread-root">
          <div className="side-thread-who">{face(root)}<strong>{root.senderName}</strong><time dateTime={root.createdAt}>{timeText(root.createdAt)}</time></div>
          <div className="prose"><MarkdownMessage body={root.body} attachments={root.attachments} /></div>
        </article>
        <p className="side-thread-count">
          {shown.length ? `${shown.length} ${shown.length === 1 ? "reply" : "replies"}` : "No replies yet. Ask a follow-up about this message."}
        </p>
        {timeline.map((message) => message.kind === "event" ? (
          <p key={message.id} className="side-thread-note" role="status">{message.body}</p>
        ) : (
          <article key={message.id} className={`side-thread-message ${message.senderType === "user" ? "mine" : ""}`}>
            {message.senderType !== "user" && <div className="side-thread-who">{face(message)}<strong>{message.senderName}</strong><time dateTime={message.createdAt}>{timeText(message.createdAt)}</time></div>}
            <div className="prose"><MarkdownMessage body={message.body} attachments={message.attachments} /></div>
          </article>
        ))}
        {working.length > 0 && <p className="side-thread-working" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />{working.join(" and ")} {working.length === 1 ? "is" : "are"} working on it…</p>}
        <div ref={end} />
      </div>
      <form className="side-thread-composer" onSubmit={(event) => void submit(event)}>
        {error && <p className="send-error" role="alert">{error}</p>}
        <div className="side-thread-field">
          <textarea ref={box} rows={1} value={draft} placeholder="Reply in thread…" aria-label="Reply in thread" disabled={busy} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKey} />
          <button type="submit" aria-label="Send reply" disabled={!draft.trim() || busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={18} />}</button>
        </div>
      </form>
    </>
  );
}
