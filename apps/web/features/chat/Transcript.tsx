"use client"

import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { ChatMessage, ChatThread, ToolCallCard, TypingIndicator } from "@workspace/ui/components/chat"
import {
  IconCircleDashed,
  IconCopy,
  IconDownload,
  IconFilter,
  IconPencil,
  IconRefresh,
  IconSquareDashed,
  IconX,
} from "@tabler/icons-react"
import { aoiSize } from "@/features/aoi/geo"
import { useAoiStore } from "@/features/aoi/store"
import type { Aoi } from "@/features/aoi/types"
import { usePaletteStore } from "@/features/palette/store"
import { openQueryForm } from "@/features/query/open"
import { queryApi, useQueryStore, type Query } from "@/features/query/store"
import { useChatStore, type TimelineItem } from "./store"

// In-flight indicator text by tool name; unmapped tools fall back to the name.
// search_scenes is an older tool that saved conversations may still hold.
const TOOL_ACTIVITY: Record<string, string> = {
  resolve_location: "Resolving the location",
  search_catalog: "Searching the STAC API",
  query_catalog: "Running the query",
  list_collections: "Reading the STAC API's collections",
  bhd_command: "Writing the download commands",
  search_scenes: "Searching the live portal",
  plot_scenes: "Plotting scenes on the map",
}

// plot_scenes is a client-side step; tool names are shown as-is.
function toolLabel(name: string): string {
  return name === "plot_scenes" ? "Plot scenes on map" : name === "query_catalog" ? "Query the STAC API (no agent)" : name
}

type Download = { loading?: boolean; steps?: { what: string; command: string }[]; note?: string; error?: string }

// The bhd commands for a query turn, each with a copy button.
function DownloadSteps({ download, onClose }: { download: Download; onClose: () => void }) {
  return (
    <div className="rounded-lg border border-border-default bg-surface-inset p-2 text-[11.5px]">
      <div className="mb-1 flex items-center justify-between text-fg-muted">
        <span className="font-medium">Download with bhd</span>
        <button type="button" aria-label="Close download commands" onClick={onClose} className="text-fg-faint hover:text-fg">
          <IconX size={12} />
        </button>
      </div>
      {download.loading && <p className="text-fg-faint">Writing the commands…</p>}
      {download.error && <p className="text-danger">{download.error}</p>}
      {download.steps?.map((s) => (
        <div key={s.command} className="mb-1.5">
          <p className="text-fg-faint">{s.what}</p>
          <div className="flex items-start gap-1">
            <code className="min-w-0 flex-1 rounded bg-surface px-1.5 py-1 font-mono text-[11px] break-all text-fg select-all">
              {s.command}
            </code>
            <button
              type="button"
              aria-label="Copy command"
              onClick={() => void navigator.clipboard.writeText(s.command)}
              className="mt-0.5 text-fg-faint hover:text-fg"
            >
              <IconCopy size={13} />
            </button>
          </div>
        </div>
      ))}
      {download.note && <p className="text-fg-faint">{download.note}</p>}
    </div>
  )
}

// Newest still-running tool call, or "Thinking" while composing a reply.
export function activeActivity(timeline: TimelineItem[]): string {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]
    if (item && item.kind === "tool" && item.status === "running") {
      return TOOL_ACTIVITY[item.name] ?? item.name.replace(/_/g, " ")
    }
  }
  return "Thinking"
}

// The question's place in line for the model, e.g. "Waiting for the model:
// 3rd in line, about 1 min". The estimate follows recent answers' times.
export function waitingText(waiting: { position: number; wait_s: number }): string {
  const place = waiting.position === 1 ? "next in line" : `${ordinal(waiting.position)} in line`
  const s = waiting.wait_s
  const about = s < 60 ? `under a minute` : `about ${Math.round(s / 60)} min`
  return `Waiting for the model: ${place}, ${about}`
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`
}

// The area a prompt was sent with. Clicking it shows that area on the map.
function AreaChip({ area }: { area: Aoi }) {
  const Icon = area.kind === "circle" ? IconCircleDashed : IconSquareDashed
  return (
    <button
      type="button"
      onClick={() => useAoiStore.getState().flyTo(area)}
      title="Asked about this area. Click to show it on the map."
      className="mr-auto flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-fg-faint hover:bg-surface-inset hover:text-fg focus-visible:outline-2 focus-visible:outline-focus-ring"
    >
      <Icon size={12} className="shrink-0" />
      {area.name && <span className="truncate">{area.name}</span>}
      <span className="shrink-0 font-mono">{aoiSize(area)}</span>
    </button>
  )
}

function PromptActions({
  area,
  isQuery,
  onEdit,
  onRetry,
  onEditQuery,
  onDownload,
}: {
  area?: Aoi
  isQuery?: boolean
  onEdit: () => void
  onRetry: () => void
  onEditQuery?: () => void
  onDownload?: () => void
}) {
  const button =
    "flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-fg-faint hover:bg-surface-inset hover:text-fg focus-visible:outline-2 focus-visible:outline-focus-ring"
  return (
    <div className="flex flex-wrap justify-end gap-1 pt-0.5">
      {isQuery && (
        <span
          title="Run from the query form; the agent was not used"
          className={`${area ? "" : "mr-auto "}flex items-center gap-1 px-1 py-0.5 text-[11px] text-fg-faint`}
        >
          <IconFilter size={12} /> Query · no agent
        </span>
      )}
      {area && <AreaChip area={area} />}
      {onEditQuery && (
        <button type="button" className={button} onClick={onEditQuery} aria-label="Edit query">
          <IconFilter size={12} /> Edit query
        </button>
      )}
      {onDownload && (
        <button type="button" className={button} onClick={onDownload} aria-label="Download commands">
          <IconDownload size={12} /> Download
        </button>
      )}
      <button type="button" className={button} onClick={onEdit} aria-label={isQuery ? "Edit as prompt" : "Edit prompt"}>
        <IconPencil size={12} /> {isQuery ? "Edit as prompt" : "Edit"}
      </button>
      <button type="button" className={button} onClick={onRetry} aria-label="Retry prompt">
        <IconRefresh size={12} /> Retry
      </button>
    </div>
  )
}

// Inline editor that replaces a user message while its prompt is being edited.
function PromptEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  const save = () => text.trim() && onSave(text.trim())
  return (
    <div className="rounded-xl border border-border-default bg-surface-inset p-2">
      <textarea
        ref={ref}
        value={text}
        rows={3}
        aria-label="Edit prompt"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Keep Esc here: it cancels the edit instead of shrinking the palette.
          e.stopPropagation()
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            save()
          } else if (e.key === "Escape") {
            e.preventDefault()
            onCancel()
          }
        }}
        className="w-full resize-none bg-transparent text-[0.8125rem] text-fg outline-none"
      />
      <p className="pb-1 text-[11px] text-fg-faint">Replaces this prompt and everything after it.</p>
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!text.trim()}
          className="rounded-md bg-action px-2 py-1 text-xs font-medium text-on-action disabled:opacity-50"
        >
          Save and rerun
        </button>
      </div>
    </div>
  )
}

// The conversation: prompts, tool steps and answers, with Edit and Retry under
// each prompt. A query turn (run from the form, without the agent) and an
// agent turn that searched also get Edit query, which reopens the search in
// the form; a query turn gets Download too. Scrolls itself; the palette gives
// it the height.
export function Transcript() {
  const timeline = useChatStore((s) => s.timeline)
  const streaming = useChatStore((s) => s.streaming)
  const waiting = useChatStore((s) => s.waiting)
  const error = useChatStore((s) => s.error)
  const rerun = useChatStore((s) => s.rerun)
  const runQuery = useChatStore((s) => s.runQuery)
  const conversationId = useChatStore((s) => s.conversationId)
  const [editing, setEditing] = useState<number | null>(null)
  const [downloads, setDownloads] = useState<Record<number, Download>>({})

  // Per turn: the agent's last search_catalog arguments, and a query turn's scene ids.
  const searches = useMemo(() => {
    const args = new Map<number, Record<string, unknown>>()
    const ids = new Map<number, string[]>()
    for (const i of timeline) {
      if (i.kind !== "tool") continue
      if (i.name === "search_catalog" && i.args) args.set(i.turn, i.args)
      if (i.name === "query_catalog" && i.result && typeof i.result === "object") {
        const scenes = (i.result as { scenes?: { id?: string }[] }).scenes ?? []
        ids.set(i.turn, scenes.map((s) => s.id).filter((id): id is string => !!id))
      }
    }
    return { args, ids }
  }, [timeline])

  const editQuery = async (turn: number, query: Query | undefined) => {
    let q = query ?? null
    const args = searches.args.get(turn)
    if (!q && args) {
      try {
        q = (await queryApi.fromSearch(args)).query
      } catch {
        return
      }
    }
    if (!q) return
    // The form's area is the area on the map; Ctrl+Z brings back the one there before.
    useAoiStore.getState().commit(q.area ?? null)
    useQueryStore.getState().open(q, turn)
    usePaletteStore.getState().setView("query")
  }

  const download = async (turn: number, query: Query) => {
    setDownloads((d) => ({ ...d, [turn]: { loading: true } }))
    try {
      const r = await queryApi.bhd(query, searches.ids.get(turn) ?? [])
      setDownloads((d) => ({ ...d, [turn]: r }))
    } catch (err) {
      setDownloads((d) => ({ ...d, [turn]: { error: (err as Error).message } }))
    }
  }

  // Keep the newest turn in view as items arrive.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el && editing === null) el.scrollTop = el.scrollHeight
  }, [timeline, streaming, editing])

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto p-3 [&_.text-sm]:text-xs [&_*]:max-w-full [&_*]:break-words"
    >
      <ChatThread>
        {timeline.map((item) => {
          if (item.kind === "tool") {
            return (
              <ToolCallCard
                key={item.id}
                name={toolLabel(item.name)}
                server={item.server ?? "bhoonidhi"}
                status={item.status}
                args={item.args}
                result={item.result}
              />
            )
          }
          if (item.role === "user" && editing === item.turn) {
            return (
              <PromptEditor
                key={item.id}
                initial={item.text}
                onCancel={() => setEditing(null)}
                onSave={(text) => {
                  setEditing(null)
                  void rerun(item.turn, text)
                }}
              />
            )
          }
          const query = item.role === "user" ? item.query : undefined
          const searched = item.role === "user" && (!!query || searches.args.has(item.turn))
          const dl = downloads[item.turn]
          return (
            <Fragment key={item.id}>
              <ChatMessage
                role={item.role}
                text={item.text}
                footer={
                  item.role === "user" && !streaming && conversationId ? (
                    <PromptActions
                      area={item.area}
                      isQuery={!!query}
                      onEdit={() => setEditing(item.turn)}
                      onRetry={() => void (query ? runQuery(query, item.turn) : rerun(item.turn, item.text))}
                      onEditQuery={searched ? () => void editQuery(item.turn, query) : undefined}
                      onDownload={query ? () => void download(item.turn, query) : undefined}
                    />
                  ) : item.role === "user" && item.area ? (
                    <div className="flex pt-0.5">
                      <AreaChip area={item.area} />
                    </div>
                  ) : undefined
                }
              />
              {item.role === "user" && dl && <DownloadSteps download={dl} onClose={() => setDownloads((d) => {
                const next = { ...d }
                delete next[item.turn]
                return next
              })} />}
            </Fragment>
          )
        })}
        {streaming && (
          <TypingIndicator label={waiting ? waitingText(waiting) : activeActivity(timeline)} />
        )}
        {waiting && (
          // The nudge: the same search without the model, now. The form
          // opens filled from the question; running it takes its place.
          <button
            type="button"
            onClick={openQueryForm}
            className="-mt-2 self-start text-[12px] text-fg-muted underline hover:text-fg"
          >
            Search now with the query form instead <span className="text-fg-faint">(?)</span>
          </button>
        )}
      </ChatThread>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  )
}
