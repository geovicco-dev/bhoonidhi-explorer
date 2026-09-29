"use client"

import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { AnimatePresence, motion } from "motion/react"
import { IconCheck, IconCopy, IconDownload, IconX } from "@tabler/icons-react"
import { useTheme } from "next-themes"
import { useChatStore, visibleScenes } from "@/features/chat/store"
import { sceneCount, type Scene } from "@/features/chat/types"
import { SceneDetailCard } from "@/features/scene/SceneDetailCard"
import { scenesHandoff, type Handoff } from "@/features/scene/handoff"
import { copyText } from "@/lib/clipboard"
import { aggregateScenes, DAY_MS, overview, sceneDate } from "./aggregate"
import { downloadFootprints } from "./footprints"
import { SceneCard } from "./SceneCard"
import { SatelliteRows } from "./SatelliteRows"
import { TimeOverview } from "./TimeOverview"

// A card's quicklook is fetched once the card comes within a few cards of the
// strip's visible part, and kept after. The card draws it as a CSS
// background, which browsers fetch for every rendered card, on screen or not:
// with up to 1,000 scenes that would be 1,000 requests to the ISRO portal.
function LazyThumbnail({ root, children }: { root: RefObject<HTMLDivElement | null>; children: (near: boolean) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || near) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true)
      },
      { root: root.current, rootMargin: "0px 600px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [root, near])
  return <div ref={ref}>{children(near)}</div>
}

const FOOTER_BUTTON =
  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-fg-muted hover:bg-surface-inset hover:text-fg focus-visible:outline-2 focus-visible:outline-focus-ring disabled:opacity-40"

// The download hand-off for the chosen scenes, fetched whenever the choice
// changes so the copy buttons copy at once: browsers allow a clipboard write
// only right after the click.
function useChosenHandoff(chosen: Scene[]): { value: Handoff | null; error: string | null } {
  const [state, setState] = useState<{ for: Scene[]; value: Handoff | null; error: string | null }>({
    for: [],
    value: null,
    error: null,
  })
  useEffect(() => {
    if (!chosen.length) return
    let live = true
    scenesHandoff(chosen)
      .then((value) => live && setState({ for: chosen, value, error: null }))
      .catch((e: Error) => live && setState({ for: chosen, value: null, error: e.message }))
    return () => {
      live = false
    }
  }, [chosen])
  // A result for an earlier choice is never offered for the current one.
  return state.for === chosen ? state : { value: null, error: null }
}

// The results of the conversation, top to bottom: the overview of every
// scene's date with the window that chooses dates; the satellite rows, showing
// only the chosen dates in a step that fits them (drag across the rows to zoom
// in further, click a satellite to show only it); the scene strip. Filters live
// in the chat store, which the map layer reads too.
export function ScenesView() {
  const scenes = useChatStore((s) => s.scenes)
  const moreScenes = useChatStore((s) => s.moreScenes)
  const timeRange = useChatStore((s) => s.timeRange)
  const setTimeRange = useChatStore((s) => s.setTimeRange)
  const satelliteFilter = useChatStore((s) => s.satelliteFilter)
  const setSatelliteFilter = useChatStore((s) => s.setSatelliteFilter)
  const selectedSceneId = useChatStore((s) => s.selectedSceneId)
  const chosenIds = useChatStore((s) => s.chosenIds)
  const chooseScene = useChatStore((s) => s.chooseScene)
  const closeScene = useChatStore((s) => s.closeScene)
  const clearChosen = useChatStore((s) => s.clearChosen)
  const requestZoom = useChatStore((s) => s.requestZoom)

  // The rows and the strip follow the window a beat behind while it is
  // dragged, so the window itself never waits on them.
  const range = useDeferredValue(timeRange)
  const filter = useDeferredValue(satelliteFilter)
  const theme = useTheme().resolvedTheme === "light" ? "light" : "dark"
  const summary = useMemo(() => overview(scenes, filter), [scenes, filter])
  const agg = useMemo(
    () =>
      aggregateScenes(
        scenes,
        range ? [Math.floor(range[0] / DAY_MS) * DAY_MS, Math.floor(range[1] / DAY_MS) * DAY_MS + DAY_MS - 1] : null,
        theme,
      ),
    [scenes, range, theme],
  )
  const shown = useMemo(() => visibleScenes(scenes, range, filter), [scenes, range, filter])
  const chosen = useMemo(() => {
    const ids = new Set(chosenIds)
    return scenes.filter((s) => ids.has(s.id))
  }, [scenes, chosenIds])
  const handoff = useChosenHandoff(chosen)
  const [copied, setCopied] = useState<"bhd" | "prompt" | null>(null)
  const copy = async (what: "bhd" | "prompt") => {
    if (!handoff.value || !(await copyText(handoff.value[what]))) return
    setCopied(what)
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500)
  }

  // A drag across the rows is held here until the pointer lifts (or Enter is
  // pressed), then becomes the new window; zooming while the pointer is still
  // down would redraw the rows under it.
  const [brush, setBrush] = useState<[number, number] | null>(null)
  const brushRef = useRef(brush)
  const onBrush = (r: [number, number] | null) => {
    brushRef.current = r
    setBrush(r)
  }
  const zoomToBrush = () => {
    const b = brushRef.current
    onBrush(null)
    if (!b || !agg) return
    const start = agg.bucketBounds[b[0]]?.[0]
    const end = agg.bucketBounds[b[1]]?.[1]
    if (start === undefined || end === undefined) return
    setTimeRange([Math.max(start, agg.extent[0]), Math.min(end - 1, agg.extent[1])])
  }

  // The selected card widens and can end up off-screen near the strip end.
  // Scroll after the width spring settles (~350ms) so the final size is used.
  const stripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!selectedSceneId) return
    const id = window.setTimeout(() => {
      stripRef.current
        ?.querySelector<HTMLElement>(`[data-scene-id="${selectedSceneId}"]`)
        ?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" })
    }, 350)
    return () => window.clearTimeout(id)
  }, [selectedSceneId])

  if (!agg || !summary) {
    return <p className="px-4 py-8 text-center text-sm text-fg-faint">No scenes yet. Ask for a place and dates.</p>
  }

  const filtered = shown.length !== scenes.length
  const none = "Select scenes first: click a card, Ctrl/Cmd+click to add one, Shift+click to add a run"

  return (
    // The results scroll; the notice stays put below them, right above the
    // footer, whatever the length of the list.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-1.5 p-3">
          <TimeOverview data={summary} range={timeRange} onRange={setTimeRange} />
          <div
            onPointerUp={zoomToBrush}
            onKeyDown={(e) => {
              if (e.key === "Enter") zoomToBrush()
            }}
          >
            <SatelliteRows
              rows={agg.rows}
              buckets={agg.buckets}
              counts={agg.counts}
              range={brush}
              onRange={onBrush}
              selectedRowIds={satelliteFilter}
              onRowClick={(id) => {
                const next = satelliteFilter.includes(id)
                  ? satelliteFilter.filter((s) => s !== id)
                  : [...satelliteFilter, id]
                // Every satellite chosen is the same as none: back to showing all.
                setSatelliteFilter(next.length === agg.rows.length ? [] : next)
              }}
              floor={theme === "light" ? 0.4 : 0.5}
            />
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-border-default px-3 py-2 text-xs text-fg-muted">
          <span className="flex items-center gap-2">
            <span className="font-mono">
              {filtered
                ? `${shown.length.toLocaleString("en")} of ${sceneCount(scenes.length, moreScenes)}`
                : sceneCount(scenes.length, moreScenes)}
            </span>
            {chosen.length > 0 && (
              <span className="inline-flex items-center gap-0.5 font-mono text-fg">
                {chosen.length.toLocaleString("en")} selected
                <button
                  type="button"
                  onClick={clearChosen}
                  aria-label="Clear the selection"
                  className="rounded p-0.5 text-fg-faint hover:bg-surface-inset hover:text-fg focus-visible:outline-2 focus-visible:outline-focus-ring"
                >
                  <IconX size={12} />
                </button>
              </span>
            )}
          </span>
          <span className="flex items-center gap-1">
            {filtered && (
              <button
                type="button"
                onClick={() => {
                  setTimeRange(null)
                  setSatelliteFilter([])
                }}
                className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-surface-inset hover:text-fg focus-visible:outline-2 focus-visible:outline-focus-ring"
              >
                Clear filters
              </button>
            )}
            {(["bhd", "prompt"] as const).map((what) => (
              <button
                key={what}
                type="button"
                disabled={!handoff.value}
                onClick={() => void copy(what)}
                title={
                  !chosen.length
                    ? none
                    : (handoff.error ??
                      (what === "bhd"
                        ? "Copy the bhd commands that download the selected scenes"
                        : "Copy a prompt for an agent with the bhoonidhi MCP server"))
                }
                className={FOOTER_BUTTON}
              >
                {copied === what ? <IconCheck size={13} className="text-success" /> : <IconCopy size={13} />}
                {what === "bhd" ? "CLI" : "MCP"}
              </button>
            ))}
            <button
              type="button"
              disabled={!chosen.length}
              onClick={() => downloadFootprints(chosen)}
              title={chosen.length ? "Save the footprints of the selected scenes as a GeoJSON file" : none}
              className={FOOTER_BUTTON}
            >
              <IconDownload size={13} /> GeoJSON
            </button>
          </span>
        </div>

        <div className="px-3">
          {shown.length > 0 ? (
            <div
              ref={stripRef}
              role="listbox"
              aria-label="Imagery scenes"
              aria-multiselectable
              className="flex gap-3 overflow-x-auto scroll-smooth p-1 select-none"
            >
              <AnimatePresence initial={false}>
                {shown.map((s) => {
                  const selected = s.id === selectedSceneId
                  const isChosen = chosenIds.includes(s.id)
                  return (
                    <motion.div
                      key={s.id}
                      layout
                      role="option"
                      aria-selected={isChosen}
                      data-scene-id={s.id}
                      className="shrink-0"
                    >
                      {selected ? (
                        <SceneDetailCard
                          scene={s}
                          onClose={closeScene}
                          onZoom={requestZoom}
                        />
                      ) : (
                        <LazyThumbnail root={stripRef}>
                          {(near) => (
                            <SceneCard
                              date={sceneDate(s)}
                              label={`${(s.selection ?? s.satellite ?? "Scene").replaceAll("_", " ")}, ${sceneDate(s)}`}
                              thumbnailSrc={near ? (s.quicklook_url ?? undefined) : undefined}
                              chosen={isChosen}
                              onClick={(e) =>
                                chooseScene(
                                  s.id,
                                  e.shiftKey ? "run" : e.metaKey || e.ctrlKey ? "toggle" : "only",
                                  shown.map((x) => x.id),
                                )
                              }
                            />
                          )}
                        </LazyThumbnail>
                      )}
                    </motion.div>
                  )
                })}
              </AnimatePresence>
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-fg-muted">No scenes match the current filter.</p>
          )}
        </div>
      </div>
      {/* One line at the palette's width; cut short on a narrower window. */}
      <p className="shrink-0 truncate px-3 pt-2 pb-1.5 text-[11.5px] leading-4 text-fg-faint">
        Availability as of the weekly update; bhd checks it live. Downloads use your own Bhoonidhi login, under the{" "}
        <a
          href="https://bhoonidhi.nrsc.gov.in/bhoonidhi/htmls/TnC.html"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-fg"
        >
          EULA
        </a>
        .
      </p>
    </div>
  )
}
