"use client"

import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { AnimatePresence, motion } from "motion/react"
import { IconCheck, IconChevronDown, IconChevronRight, IconCopy, IconDownload, IconLoader2, IconX } from "@tabler/icons-react"
import { useTheme } from "next-themes"
import { isPaged, useChatStore, visibleScenes } from "@/features/chat/store"
import type { Scene } from "@/features/chat/types"
import { EDGE_ARROW_OVERHANG, SceneDetailCard } from "@/features/scene/SceneDetailCard"
import { useCellSteps } from "@/features/scene/cellSteps"
import { isReady, portalSummary } from "@/features/scene/availability"
import { scenesHandoff, type Handoff } from "@/features/scene/handoff"
import { copyText } from "@/lib/clipboard"
import { aggregateScenes, DAY_MS, overview, sceneDate } from "./aggregate"
import { useDrill, useRowsOpen } from "./drill"
import { downloadFootprints } from "./footprints"
import { SceneCard } from "./SceneCard"
import { ROWS_MIN_H, SatelliteRows } from "./SatelliteRows"
import { tallyFromScenes } from "./tally"
import { TimeOverview } from "./TimeOverview"
import {
  countLine,
  loadMoreStrip,
  useChosenScenes,
  useResultCount,
  useScene,
  useSceneSource,
  useWhole,
  windowTally,
  type Counted,
} from "./whole"

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

// What stands in for the graph and the rows of a result that holds only its
// newest scenes, until the STAC API has counted it, or when it could not.
function CountStatus({ counted }: { counted: Counted }) {
  return (
    <div className="flex min-h-24 shrink-0 items-center justify-center gap-2 px-6 pt-3 text-center text-xs text-fg-muted">
      {counted.status === "counting" ? (
        <>
          <IconLoader2 size={16} className="shrink-0 animate-spin text-fg-faint" aria-hidden />
          Counting every scene that matches…
        </>
      ) : counted.status === "ok" ? null : (
        <p role="status">{counted.message}</p>
      )}
    </div>
  )
}

// The results of the conversation, top to bottom: the overview of every
// scene's date with the window that chooses dates; the breadcrumb and the
// rows (satellites, or the sensors or products of the row opened), showing
// only the chosen dates in a step that fits them (drag across the rows to
// zoom in further); the scene strip. Filters live in the chat store, which
// the map layer reads too.
export function ScenesView() {
  const scenes = useChatStore((s) => s.scenes)
  const moreScenes = useChatStore((s) => s.moreScenes)
  const result = useChatStore((s) => s.result)
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
  const openOnMap = useChatStore((s) => s.openOnMap)
  const steps = useCellSteps(useScene(selectedSceneId))

  // A result that holds only its newest scenes reads its counts from the
  // STAC API and its scenes from pages (whole.ts); any other, from its own
  // scenes.
  const paged = isPaged(result)
  const counted = useWhole((s) => s.base)
  const narrow = useWhole((s) => s.narrow)
  const strip = useWhole((s) => s.strip)
  const own = useMemo(() => (paged ? null : tallyFromScenes(scenes)), [paged, scenes])
  const base = paged ? (counted.status === "ok" ? counted.tally : null) : own

  // The rows and the strip follow the window a beat behind while it is
  // dragged, so the window itself never waits on them.
  const range = useDeferredValue(timeRange)
  const filter = useDeferredValue(satelliteFilter)
  const theme = useTheme().resolvedTheme === "light" ? "light" : "dark"
  const win = useMemo(() => windowTally(base, narrow, range), [base, narrow, range])
  const summary = useMemo(() => (base ? overview(base, filter) : null), [base, filter])
  const agg = useMemo(
    () =>
      base && win
        ? aggregateScenes(
            base,
            range ? [Math.floor(range[0] / DAY_MS) * DAY_MS, Math.floor(range[1] / DAY_MS) * DAY_MS + DAY_MS - 1] : null,
            theme,
            win.step,
          )
        : null,
    [base, win, range, theme],
  )
  const stripSource = useSceneSource()
  const shown = useMemo(() => visibleScenes(stripSource, range, filter), [stripSource, range, filter])
  const resultCount = useResultCount(range, filter)
  const drill = useDrill(result, base, win, agg, satelliteFilter, setSatelliteFilter)
  // Opening a row or following the breadcrumb replaces the rows, and the
  // button that was clicked goes with them, which leaves focus on the page.
  // Focus goes back to the rows so Esc still steps up a level.
  const rowsRef = useRef<HTMLDivElement>(null)
  const lastLevel = useRef(drill.level)
  useEffect(() => {
    if (lastLevel.current === drill.level) return
    lastLevel.current = drill.level
    if (document.activeElement === document.body) rowsRef.current?.focus({ preventScroll: true })
  }, [drill.level])
  const rowsOpen = useRowsOpen((s) => s.open)
  const setRowsOpen = useRowsOpen((s) => s.toggle)
  const chosen = useChosenScenes()
  // The hand-off downloads only the chosen scenes that are Ready; the
  // tooltip names the others, which need the portal.
  const chosenReady = useMemo(() => chosen.filter(isReady), [chosen])
  const handoff = useChosenHandoff(chosenReady)
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

  if (!scenes.length || (!paged && (!agg || !summary))) {
    return <p className="px-4 py-8 text-center text-sm text-fg-faint">No scenes yet. Ask for a place and dates.</p>
  }

  // How many scenes show, against the row opened (the whole result at the
  // top). A result that holds only its newest scenes counts them in the STAC
  // API; until the count comes, or if the STAC API could not count, its own
  // scenes are all there is to go on.
  const filtered = paged ? !!timeRange || satelliteFilter.length > 0 : shown.length !== scenes.length
  // The strip asks for the next page as its end comes into view.
  const onStripScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (paged && el.scrollLeft + el.clientWidth >= el.scrollWidth - 600) loadMoreStrip()
  }
  const none = "Select scenes first: click a card, Ctrl/Cmd+click to add one, Shift+click to add a run"
  // What the CLI and MCP buttons say on hover, for the current selection.
  const handoffTitle = (what: "bhd" | "prompt") => {
    if (!chosen.length) return none
    if (!chosenReady.length) return `No selected scene is Ready: ${portalSummary(chosen)}`
    if (handoff.error) return handoff.error
    const others = chosen.length > chosenReady.length ? `; ${portalSummary(chosen)}` : ""
    const n = chosenReady.length
    const which = others ? (n === 1 ? "the 1 Ready scene" : `the ${n.toLocaleString("en")} Ready scenes`) : "the selected scenes"
    return what === "bhd"
      ? `Copy the bhd commands that download ${which}${others}`
      : `Copy a prompt for an agent with the bhoonidhi MCP server to download ${which}${others}`
  }

  return (
    // The results scroll; the notice stays put below them, right above the
    // footer, whatever the length of the list.
    <div className="flex min-h-0 flex-1 flex-col">
      {/* When the tab is short, only the rows give up height (they scroll
          inside the chart, down to two rows), so the scene strip stays in
          view. On a window too short even for that, the whole tab scrolls. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {!agg || !summary ? (
          <CountStatus counted={counted} />
        ) : (
          <>
        <div className="flex shrink-0 flex-col gap-1.5 px-3 pt-3">
          <TimeOverview data={summary} range={timeRange} onRange={setTimeRange} labelWidth={drill.labelWidth} />
          <div className="flex h-4 items-center justify-between gap-2 font-mono text-[10px]">
            <nav aria-label="Rows shown" className="flex min-w-0 items-center gap-1">
              {drill.crumbs.map((c, i) => {
                const last = i === drill.crumbs.length - 1
                return (
                  <span key={c.level} className="flex min-w-0 items-center gap-1">
                    {i > 0 && <IconChevronRight size={10} stroke={2.25} className="shrink-0 text-fg-faint" aria-hidden />}
                    {last ? (
                      <span className="truncate text-fg" aria-current="location">
                        {c.label}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => drill.goTo(c.level)}
                        className="truncate rounded-[2px] text-fg-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline-2 focus-visible:outline-focus-ring"
                      >
                        {c.label}
                      </button>
                    )}
                  </span>
                )
              })}
            </nav>
            <button
              type="button"
              onClick={setRowsOpen}
              aria-expanded={rowsOpen}
              className="flex shrink-0 items-center gap-0.5 rounded-[2px] text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus-ring"
            >
              {rowsOpen ? "Hide rows" : `Show rows (${drill.rows.length})`}
              <IconChevronDown
                size={11}
                stroke={2.25}
                aria-hidden
                className={[
                  "transition-transform duration-150 motion-reduce:transition-none",
                  rowsOpen ? "rotate-180" : "",
                ].join(" ")}
              />
            </button>
          </div>
        </div>
        {rowsOpen && (
          <div
            ref={rowsRef}
            tabIndex={-1}
            className="flex min-h-0 flex-col px-3 pt-1.5 outline-none"
            // The rows plus the 6 px above them.
            style={{ minHeight: ROWS_MIN_H + 6 }}
            onPointerUp={zoomToBrush}
            onKeyDown={(e) => {
              if (e.key === "Enter") zoomToBrush()
              // Esc steps back up a level, once no stretch is marked.
              if (e.key === "Escape" && drill.level > 0 && !brushRef.current) {
                e.stopPropagation()
                drill.goTo(drill.level - 1)
              }
            }}
          >
            <SatelliteRows
              rows={drill.rows}
              buckets={agg.buckets}
              counts={drill.counts}
              range={brush}
              onRange={onBrush}
              onOpen={drill.onOpen}
              onChoose={drill.onChoose}
              floor={theme === "light" ? 0.4 : 0.5}
              labelWidth={drill.labelWidth}
            />
          </div>
        )}
          </>
        )}
        <div className="h-3 shrink-0" />

        <div className="flex shrink-0 items-center justify-between border-t border-border-default px-3 py-2 text-xs text-fg-muted">
          <span className="flex items-center gap-2">
            <span className="font-mono">
              {resultCount.counting ? (
                <span className="inline-flex items-center gap-1.5">
                  <IconLoader2 size={12} className="animate-spin text-fg-faint" aria-hidden />
                  Counting scenes…
                </span>
              ) : (
                countLine(resultCount, scenes.length, moreScenes)
              )}
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
                  drill.reset()
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
                title={handoffTitle(what)}
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
              onScroll={onStripScroll}
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
                      // Room for the arrows on the open card's edges.
                      style={selected && steps ? { paddingInline: EDGE_ARROW_OVERHANG } : undefined}
                    >
                      {selected ? (
                        <SceneDetailCard
                          scene={s}
                          onClose={closeScene}
                          onZoom={requestZoom}
                          steps={steps}
                          onStep={openOnMap}
                        />
                      ) : (
                        <LazyThumbnail root={stripRef}>
                          {(near) => (
                            <SceneCard
                              date={sceneDate(s)}
                              label={`${(s.selection ?? s.satellite ?? "Scene").replaceAll("_", " ")}, ${sceneDate(s)}`}
                              thumbnailSrc={near ? (s.quicklook_url ?? undefined) : undefined}
                              chosen={isChosen}
                              onClick={(e) => {
                                const how = e.shiftKey ? "run" : e.metaKey || e.ctrlKey ? "toggle" : "only"
                                chooseScene(s.id, how, shown.map((x) => x.id))
                                // A plain click frames the scene; adding to
                                // the selection leaves the camera where it is.
                                if (how === "only") requestZoom()
                              }}
                            />
                          )}
                        </LazyThumbnail>
                      )}
                    </motion.div>
                  )
                })}
              </AnimatePresence>
              {paged && strip?.loading && (
                <div className="flex shrink-0 items-center px-3" aria-label="Loading more scenes">
                  <IconLoader2 size={16} className="animate-spin text-fg-faint" aria-hidden />
                </div>
              )}
            </div>
          ) : paged && strip?.loading ? (
            <p className="flex items-center justify-center gap-1.5 py-4 text-xs text-fg-muted">
              <IconLoader2 size={12} className="animate-spin" aria-hidden /> Loading scenes…
            </p>
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
