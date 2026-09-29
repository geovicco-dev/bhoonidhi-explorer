"use client"

import type { ConversationSummary } from "./stream"
import { ago } from "./palette"

export const RECENT_ID = "palette-recent"
export const RECENT_SHOWN = 5
export const recentOptionId = (id: string) => `palette-recent-${id}`

type Props = {
  conversations: ConversationSummary[]
  // Highlighted row, moved by the arrow keys in the palette's input; -1 for none.
  active: number
  onActive: (index: number) => void
  onOpen: (id: string) => void
  // Days the server keeps a conversation after its last activity; 0 or null
  // (not loaded) shows no notice.
  retentionDays: number | null
}

// The newest conversations, shown when the palette opens on nothing. Queries
// are saved as conversations too, so both appear here. Under them, how long
// the server keeps them.
export function Recent({ conversations, active, onActive, onOpen, retentionDays }: Props) {
  if (!conversations.length) return null
  return (
    <div className="border-t border-border-default px-1.5 py-1.5">
      <p className="px-2 pb-1 text-[10.5px] font-medium tracking-wide text-fg-faint uppercase">Recent</p>
      <div id={RECENT_ID} role="listbox" aria-label="Recent sessions">
        {conversations.map((c, index) => (
          <div
            key={c.id}
            id={recentOptionId(c.id)}
            role="option"
            aria-selected={index === active}
            onMouseMove={() => onActive(index)}
            // Keeps focus, and so the arrow keys, in the palette's input.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onOpen(c.id)}
            className={`flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1 text-[13px] ${index === active ? "bg-surface-inset" : ""}`}
          >
            <span className="min-w-0 flex-1 truncate text-fg">{c.title || "Untitled"}</span>
            <span className="shrink-0 text-[11px] text-fg-faint">{ago(c.updated_at)}</span>
          </div>
        ))}
      </div>
      {!!retentionDays && (
        <p className="px-2 pt-1 text-[11px] text-fg-faint">
          Sessions are deleted after {retentionDays} {retentionDays === 1 ? "day" : "days"} without use.
        </p>
      )}
    </div>
  )
}
