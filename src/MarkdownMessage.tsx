import { Children, isValidElement, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Attachment } from "./shared/types";

function highlightMentions(children: ReactNode) {
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    return child.split(/(@[\p{L}\p{N}_-]+)/gu).map((part, index) => part.startsWith("@") ? <mark className="mention" key={`${part}-${index}`}>{part}</mark> : part);
  });
}

/** Fenced code, as in ChatGPT or Claude: the language named in a quiet
 * header and one tap to copy, confirmed with a checkmark. */
function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = Children.toArray(children).find(isValidElement) as { props?: { className?: string; children?: ReactNode } } | undefined;
  const language = /language-([\w+#-]+)/.exec(code?.props?.className || "")?.[1] || "";
  const text = String(Children.toArray(code?.props?.children ?? "").join("")).replace(/\n$/, "");
  return <div className="code-block">
    <div className="code-block-bar">
      <span>{language}</span>
      <button type="button" onClick={() => void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(() => {})} aria-label={copied ? "Copied" : "Copy code"}>
        {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy"}
      </button>
    </div>
    <pre>{children}</pre>
  </div>;
}

export function MarkdownMessage({ body, attachments = [] }: { body: string; attachments?: Attachment[] }) {
  const attachmentHref = (href: string | undefined) => {
    if (!href || /^[a-z]+:\/\//i.test(href) || href.startsWith("/api/")) return href;
    let candidate = href.split(/[?#]/)[0]!.split("/").at(-1) || href;
    try { candidate = decodeURIComponent(candidate); } catch { /* keep the literal name */ }
    return attachments.find((attachment) => attachment.source === "artifact" && attachment.name === candidate)?.url || href;
  };
  return <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
    p: ({ children }) => <p>{highlightMentions(children)}</p>,
    li: ({ children }) => <li>{highlightMentions(children)}</li>,
    a: ({ href, children }) => <a href={attachmentHref(href)} target="_blank" rel="noreferrer">{children}</a>,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
  }}>{body}</ReactMarkdown>;
}
