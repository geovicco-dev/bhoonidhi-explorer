"use client"

import { memo, useState, type HTMLAttributes, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { IconChevronDown, IconSettings } from "@tabler/icons-react"
import { cn } from "@workspace/ui/lib/utils"

// The conversation's parts: the thread, one message, a tool call, and the
// "working" pill shown while the agent answers.

export function ChatThread({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-4", className)} {...props} />
}

type Role = "user" | "assistant"

const BUBBLE: Record<Role, string> = {
  user: "bg-action text-on-action",
  assistant: "bx-surface border border-border-default text-fg",
}
const AUTHOR: Record<Role, string> = { user: "You", assistant: "Agent" }

// A user's text is shown as typed; the agent's is Markdown (bold, lists,
// tables, code, links).
export function ChatMessage({
  className,
  role,
  text,
  footer,
  ...props
}: HTMLAttributes<HTMLDivElement> & { role: Role; text: string; footer?: ReactNode }) {
  return (
    <div
      className={cn("flex flex-col gap-1.5", role === "user" ? "items-end" : "items-start", className)}
      {...props}
    >
      <div className="flex items-center gap-1.5 px-1 text-xs font-medium text-fg-faint">{AUTHOR[role]}</div>
      <div className={cn("max-w-prose rounded-xl px-3.5 py-2.5 text-sm leading-relaxed", BUBBLE[role])}>
        {role === "user" ? <p className="whitespace-pre-wrap">{text}</p> : <Markdown>{text}</Markdown>}
      </div>
      {footer ? <div className="max-w-prose px-1">{footer}</div> : null}
    </div>
  )
}

// Sized for a narrow chat bubble: tables scroll sideways instead of widening it.
const MARKDOWN: Components = {
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-action underline underline-offset-2 hover:text-action-hover">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-4">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => <h1 className="mt-2 mb-1 text-base font-semibold text-fg first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-2 mb-1 text-sm font-semibold text-fg first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1 text-sm font-semibold text-fg-muted first:mt-0">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-border-default pl-3 text-fg-muted">{children}</blockquote>
  ),
  hr: () => <hr className="my-2 border-border-default" />,
  // Fenced code arrives with a language class inside <pre>; inline code has none.
  code: ({ className, children }) =>
    /language-/.test(className ?? "") ? (
      <code className={cn("font-mono text-xs", className)}>{children}</code>
    ) : (
      <code className="rounded bg-surface-inset px-1 py-0.5 font-mono text-[0.85em] text-fg">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md border border-border-default bg-surface-inset p-2.5 text-fg">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border-default">{children}</thead>,
  th: ({ children }) => <th className="px-2 py-1 text-left font-semibold text-fg">{children}</th>,
  td: ({ children }) => <td className="border-b border-border-default px-2 py-1 text-fg-muted">{children}</td>,
}

const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>
        {children}
      </ReactMarkdown>
    </div>
  )
})

type Status = "running" | "succeeded" | "failed"

const STATUS: Record<Status, { label: string; className: string }> = {
  running: { label: "Running", className: "border-info/30 bg-info/10 text-info" },
  succeeded: { label: "Succeeded", className: "border-success/30 bg-success/10 text-success" },
  failed: { label: "Failed", className: "border-danger/30 bg-danger/10 text-danger" },
}

function formatJson(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// One tool call: name, where it ran, and its state. Opens to show the
// arguments and the result.
export function ToolCallCard({
  className,
  name,
  server,
  status,
  args,
  result,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  name: string
  server?: string
  status: Status
  args?: unknown
  result?: unknown
}) {
  const [open, setOpen] = useState(false)
  const hasBody = args != null || result != null
  const badge = STATUS[status]
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border-default bg-surface-raised", className)} {...props}>
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        aria-expanded={hasBody ? open : undefined}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          hasBody && "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring",
        )}
      >
        {hasBody ? (
          <IconChevronDown size={14} className={cn("shrink-0 text-fg-faint transition-transform", !open && "-rotate-90")} />
        ) : (
          <IconSettings size={14} className="shrink-0 text-fg-faint" />
        )}
        <span className="font-mono text-xs font-medium text-fg">{name}</span>
        {server ? <span className="truncate font-mono text-[11px] text-fg-faint">{server}</span> : null}
        <div className="flex-1" />
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-xs font-medium whitespace-nowrap",
            badge.className,
          )}
        >
          {status === "running" ? <TileSpinner /> : null}
          {badge.label}
        </span>
      </button>
      {open && hasBody ? (
        <div className="flex flex-col gap-2 border-t border-border-default px-3 py-2.5">
          {args != null ? (
            <div>
              <div className="mb-1 text-[11px] font-medium tracking-wide text-fg-faint uppercase">Arguments</div>
              <pre className="overflow-x-auto rounded-md border border-border-default bg-surface-inset p-2 font-mono text-xs text-fg">
                <code>{formatJson(args)}</code>
              </pre>
            </div>
          ) : null}
          {result != null ? (
            <div>
              <div className="mb-1 text-[11px] font-medium tracking-wide text-fg-faint uppercase">Result</div>
              <pre
                className={cn(
                  "overflow-x-auto rounded-md border p-2 font-mono text-xs",
                  status === "failed"
                    ? "border-danger/30 bg-danger/5 text-danger"
                    : "border-border-default bg-surface-inset text-fg",
                )}
              >
                <code>{formatJson(result)}</code>
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// A 3x3 grid of map tiles pulsing in a diagonal wave; still under reduced motion.
const DELAYS = [0, 120, 240, 120, 240, 360, 240, 360, 480]

function TileSpinner() {
  return (
    <span role="status" aria-label="Loading" className="inline-block size-3 text-current motion-reduce:[&_rect]:animate-none">
      <svg viewBox="0 0 30 30" width="100%" height="100%" aria-hidden="true">
        {DELAYS.map((delay, i) => (
          <rect
            key={i}
            x={(i % 3) * 10 + 1}
            y={Math.floor(i / 3) * 10 + 1}
            width={8}
            height={8}
            rx={1.5}
            fill="currentColor"
            className="bx-tile-cell"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </svg>
    </span>
  )
}

// Shown while the agent works; `label` names the current step.
export function TypingIndicator({ className, label, ...props }: HTMLAttributes<HTMLDivElement> & { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label ?? "Agent is typing"}
      className={cn("inline-flex items-center gap-2 rounded-full border border-border-default bg-surface-inset px-3 py-1.5", className)}
      {...props}
    >
      {label ? <span className="text-xs font-medium text-fg-muted">{label}</span> : null}
      <span className="flex items-center gap-1" aria-hidden>
        <span className="size-1.5 animate-bounce rounded-full bg-fg-faint [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-fg-faint [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-fg-faint" />
      </span>
    </div>
  )
}
