"use client"

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"
import {
  IconArrowUp,
  IconChevronRight,
  IconDots,
  IconFilter,
  IconLoader2,
  IconMapPinSearch,
  IconPlayerStopFilled,
  IconTerminal2,
} from "@tabler/icons-react"
import { useChatStore, visibleScenes } from "@/features/chat/store"
import { sceneCount } from "@/features/chat/types"
import { Transcript, activeActivity, waitingText } from "@/features/chat/Transcript"
import { convPage } from "@/features/chat/palette"
import { RECENT_ID, RECENT_SHOWN, Recent, recentOptionId } from "@/features/chat/Recent"
import { SUGGESTIONS } from "@/features/chat/suggestions"
import { ScenesView } from "@/features/timeline/ScenesView"
import { placeRows } from "@/features/aoi/palette"
import { PLACE_PREFIX, usePlaceStore } from "@/features/aoi/places"
import { useAoiStore } from "@/features/aoi/store"
import { useCommands } from "./commands"
import { TileMark } from "./TileMark"
import { matchItems, type Match } from "./match"
import { usePaletteStore, type PaletteTab } from "./store"
import type { PaletteItem, PalettePage } from "./types"
import { QueryForm, useRunQuery } from "@/features/query/QueryForm"
import { ArchiveView } from "@/features/query/ArchiveView"
import { QUERY_KEYS, SHORTCUT_PREFIX, openArchive, openQueryForm } from "@/features/query/open"
import { useQueryStore } from "@/features/query/store"
import { LegendStrip } from "@/features/scene/AvailabilityLegend"

// The one control surface. A bar at the top left of the map:
//   - plain text is a question for the agent (Enter sends);
//   - ">" switches to commands (fuzzy list, drill-down pages);
//   - "@" searches for a place (Enter searches, then flies there);
//   - Tab fills in the rotating suggestion shown as ghost text.
// Focusing it expands a panel with two tabs, Conversation and Scenes. Esc, a
// map click or Ctrl/Cmd+K shrinks it back to the bar.

const LIST_ID = "palette-list"
const COMMAND_PREFIX = ">"

// The panel's open and shut states. Module constants, so the end of the shut
// animation can be told apart by identity in onAnimationComplete.
const PANEL_OPEN = { opacity: 1, height: "auto" }
const PANEL_SHUT = { opacity: 0, height: 0 }

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border-default bg-surface-inset px-1.5 py-px font-mono text-[10px] text-fg-muted">
      {children}
    </kbd>
  )
}

function Highlighted({ text, positions }: { text: string; positions: Set<number> }) {
  if (!positions.size) return <>{text}</>
  return (
    <>
      {[...text].map((ch, i) =>
        positions.has(i) ? (
          <span key={i} className="font-semibold text-fg">
            {ch}
          </span>
        ) : (
          <Fragment key={i}>{ch}</Fragment>
        ),
      )}
    </>
  )
}

// Rotates through the suggestions while the input is empty. Honours
// prefers-reduced-motion (swaps without the fade).
function useRotatingSuggestion(active: boolean, intervalMs = 3600) {
  const [index, setIndex] = useState(0)
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    if (!active) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const id = window.setInterval(() => {
      if (reduce) {
        setIndex((i) => (i + 1) % SUGGESTIONS.length)
        return
      }
      setVisible(false)
      window.setTimeout(() => {
        setIndex((i) => (i + 1) % SUGGESTIONS.length)
        setVisible(true)
      }, 220)
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [active, intervalMs])
  return { suggestion: SUGGESTIONS[index] ?? "", visible }
}

// The drawing gesture the empty bar names while an area is drawn or edited.
function drawHintFor(tool: string | null, editing: boolean): string | null {
  return tool === "rectangle"
    ? "Drag, or click two corners · Shift for a square · Esc to cancel"
    : tool === "point"
      ? "Click the centre, then the edge · click twice for 10 km · Esc to cancel"
      : editing
        ? "Drag a handle to resize or the area to move · Enter when done"
        : null
}

// `count` is already formatted ("176", "1,000+"); empty hides the badge.
function Tabs({ tab, setTab, count }: { tab: PaletteTab; setTab: (t: PaletteTab) => void; count: string }) {
  const tabs: { id: PaletteTab; label: string; count?: string }[] = [
    { id: "conversation", label: "Session" },
    { id: "scenes", label: "Scenes", count },
  ]
  return (
    <div role="tablist" aria-label="Palette views" className="flex gap-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => setTab(t.id)}
          className={[
            "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus-ring",
            tab === t.id ? "bg-surface-inset text-fg" : "text-fg-faint hover:text-fg",
          ].join(" ")}
        >
          {t.label}
          {t.count ? <span className="ml-1 font-mono text-fg-faint">{t.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function CommandPalette() {
  const expanded = usePaletteStore((s) => s.expanded)
  const expand = usePaletteStore((s) => s.expand)
  const collapse = usePaletteStore((s) => s.collapse)
  const tab = usePaletteStore((s) => s.tab)
  const setTab = usePaletteStore((s) => s.setTab)
  const path = usePaletteStore((s) => s.path)
  const openAt = usePaletteStore((s) => s.openAt)
  const push = usePaletteStore((s) => s.push)
  const pop = usePaletteStore((s) => s.pop)
  const popTo = usePaletteStore((s) => s.popTo)
  const query = usePaletteStore((s) => s.query)
  const setQuery = usePaletteStore((s) => s.setQuery)
  const storedActive = usePaletteStore((s) => s.active)
  const setActive = usePaletteStore((s) => s.setActive)
  const view = usePaletteStore((s) => s.view)
  const setView = usePaletteStore((s) => s.setView)
  // The query form and the archive use the input as their filter.
  const formView = view !== "main"
  const runQuery = useRunQuery()
  const queryBlocked = useQueryStore((s) => s.problems.length > 0 || s.checking || !!s.error)
  const editingTurn = useQueryStore((s) => s.editingTurn)

  const streaming = useChatStore((s) => s.streaming)
  const waiting = useChatStore((s) => s.waiting)
  const retentionDays = useChatStore((s) => s.retentionDays)
  const send = useChatStore((s) => s.send)
  const stop = useChatStore((s) => s.stop)
  const title = useChatStore((s) => s.title)
  const conversationId = useChatStore((s) => s.conversationId)
  const timeline = useChatStore((s) => s.timeline)
  const hasConversation = timeline.length > 0
  const timeRange = useChatStore((s) => s.timeRange)
  const satelliteFilter = useChatStore((s) => s.satelliteFilter)
  const scenes = useChatStore((s) => s.scenes)
  const moreScenes = useChatStore((s) => s.moreScenes)
  const chosenCount = useChatStore((s) => s.chosenIds.length)
  const refreshList = useChatStore((s) => s.refreshList)
  const newConversation = useChatStore((s) => s.newConversation)
  const openConversation = useChatStore((s) => s.open)
  const conversations = useChatStore((s) => s.conversations)
  const recent = conversations.slice(0, RECENT_SHOWN)
  // Highlighted row of the Recent list; -1 for none.
  const [recentActive, setRecentActive] = useState(-1)

  const commandMode = !formView && (path.length > 0 || query.startsWith(COMMAND_PREFIX))
  const commandQuery = path.length ? query : query.slice(COMMAND_PREFIX.length).trimStart()
  // "@" at the start: place search. Listed like commands, but Enter searches first.
  const placeMode = !formView && !commandMode && query.startsWith(PLACE_PREFIX)
  const placeText = placeMode ? query.slice(PLACE_PREFIX.length).trim() : ""
  const listMode = commandMode || placeMode
  const placeSearch = usePlaceStore()
  const places = placeMode ? placeRows(placeText, placeSearch) : null
  const searchPlaces = placeSearch.search

  const aoi = useAoiStore((s) => s.aoi)
  const tool = useAoiStore((s) => s.tool)
  const editing = useAoiStore((s) => s.editing)

  const { root, resolvePage } = useCommands(expanded && commandMode, () => {
    setQuery(PLACE_PREFIX)
    expand()
    inputRef.current?.focus()
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const { suggestion, visible: suggestionVisible } = useRotatingSuggestion(!query && !hasConversation && !aoi)

  // The conversation list feeds the command pages; load it once up front.
  useEffect(() => {
    void refreshList()
  }, [refreshList])

  // Esc leaves the query form or the archive for the conversation; Esc again
  // closes. Ctrl/Cmd+K toggles the panel from anywhere.
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && expanded) {
        e.preventDefault()
        if (formView) {
          setView("main")
          return
        }
        collapse()
        inputRef.current?.blur()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        if (expanded) {
          collapse()
          inputRef.current?.blur()
        } else {
          expand()
          inputRef.current?.focus()
        }
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [expanded, expand, collapse, formView, setView])

  // Keep typing focus in the input after every page change.
  useEffect(() => {
    if (expanded) inputRef.current?.focus()
  }, [expanded, path, view])

  // A search that returns scenes switches to the Scenes tab.
  const sceneBatch = useRef(scenes)
  useEffect(() => {
    if (scenes !== sceneBatch.current) {
      sceneBatch.current = scenes
      if (scenes.length) setTab("scenes")
    }
  }, [scenes, setTab])

  // Clicking the map (anywhere outside the palette) shrinks it to the bar,
  // except in the query form, where the map is where the area is drawn.
  useEffect(() => {
    if (!expanded || formView) return
    const onDown = (e: PointerEvent) => {
      if (shellRef.current && !shellRef.current.contains(e.target as Node)) collapse()
    }
    window.addEventListener("pointerdown", onDown)
    return () => window.removeEventListener("pointerdown", onDown)
  }, [expanded, collapse, formView])

  const pageId = path.at(-1)
  const page: PalettePage | null = pageId ? resolvePage(pageId) : null
  const trail = path.map((id) => resolvePage(id)?.title ?? id)

  const commandMatches: Match[] = useMemo(() => {
    if (!commandMode) return []
    const items = page ? page.items : root.filter((i) => commandQuery.trim() || !i.searchOnly)
    return matchItems(items, commandQuery)
  }, [commandMode, page, root, commandQuery])
  // Place rows come ranked from the geocoder; nothing to fuzzy-match.
  const matches: Match[] = places
    ? places.items.map((item: PaletteItem) => ({ item, labelPositions: new Set<number>() }))
    : commandMatches

  // Sections only when browsing a list unfiltered; a query gives one ranked list.
  const showSections = placeMode ? !placeText : !page && !commandQuery.trim()

  // The list can shrink under the highlight (e.g. place results arrive).
  const active = Math.min(storedActive, Math.max(matches.length - 1, 0))

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [active])

  const ask = (text: string) => {
    if (streaming) return
    setQuery("")
    setTab("conversation")
    expand()
    void send(text)
  }

  // Running a command leaves command mode but keeps the panel open, so the
  // result is visible. `alt` (Shift+Enter, Shift+click) runs a row's second
  // action when it has one.
  const choose = (index: number, alt = false) => {
    const item = matches[index]?.item
    if (!item || item.disabled) return
    if (item.pageId) {
      push(item.pageId, item.pageQuery)
      return
    }
    const action = alt && item.altRun ? item.altRun : item.run
    if (action) {
      popTo(0)
      action()
    }
  }

  const step = (delta: number) => {
    if (!matches.length) return
    let i = active
    // Skip disabled rows; give up after one full loop.
    for (let n = 0; n < matches.length; n++) {
      i = (i + delta + matches.length) % matches.length
      if (!matches[i]!.item.disabled) break
    }
    setActive(i)
  }

  // The Recent list shows on an empty panel; the arrow keys reach it while
  // nothing is typed.
  const recentShown = !formView && !listMode && !hasConversation && recent.length > 0
  const recentKeys = recentShown && !query
  const recentIndex = recentKeys ? Math.min(recentActive, recent.length - 1) : -1

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        if (recentKeys) {
          e.preventDefault()
          setRecentActive((recentIndex + 1) % recent.length)
          return
        }
        if (!listMode) return
        e.preventDefault()
        step(1)
        break
      case "ArrowUp":
        if (recentKeys) {
          e.preventDefault()
          setRecentActive(recentIndex <= 0 ? recent.length - 1 : recentIndex - 1)
          return
        }
        if (!listMode) return
        e.preventDefault()
        step(-1)
        break
      case "Enter":
        e.preventDefault()
        if (recentIndex >= 0) {
          void openConversation(recent[recentIndex]!.id)
          setRecentActive(-1)
        } else if (view === "query") {
          // Runs only a checked query with no problems; useRunQuery also
          // refuses while a run or the agent is busy. A question only
          // waiting in line does not block it: the query takes its place.
          if (!queryBlocked && (!streaming || waiting)) void runQuery()
        } else if (formView) {
          // The archive has nothing to run from the input.
        } else if (page?.onSubmit) {
          if (query.trim()) {
            page.onSubmit(query.trim())
            popTo(0)
          }
        } else if (places) {
          // New text searches; once results are in, Enter picks one.
          if (places.canSearch) void searchPlaces(placeText)
          else choose(active, e.shiftKey)
        } else if (commandMode) {
          choose(active, e.shiftKey)
        } else if (query.trim()) {
          ask(query.trim())
        }
        break
      case "Tab":
        // Tab fills in the ghost suggestion; focus stays in the input. In the
        // query form it moves on to the fields.
        if (formView) break
        e.preventDefault()
        if (!query && !listMode && !areaName) setQuery(suggestion)
        break
      case "Backspace":
        if (!query && formView) {
          e.preventDefault()
          setView("main")
        } else if (!query && path.length) {
          e.preventDefault()
          pop()
        }
        break
      case "[":
      case "]":
        // With the bar empty and the two tabs showing, [ and ] switch tabs;
        // otherwise they are typed.
        if (!query && !formView && hasConversation) {
          e.preventDefault()
          setTab(e.key === "[" ? "conversation" : "scenes")
        }
        break
    }
  }

  const activeItem = matches[active]?.item
  // Every question goes out with the area, so the bar names it.
  const areaName = aoi ? (aoi.name ?? "this area") : null
  const placeholder =
    view === "query" && !drawHintFor(tool, editing)
      ? "Filter satellites and products…"
      : view === "archive"
        ? "Filter: satellite, sensor, product, operator…"
        : formView
          ? ""
          : (page?.placeholder ??
            (commandMode
              ? "Type a command…"
              : hasConversation && expanded && !streaming
                ? areaName
                  ? `Ask a follow-up about ${areaName}…`
                  : "Ask a follow-up…"
                : ""))
  // In the query form the bar still names the drawing gesture while an area is drawn.
  const showGhost = !query && !listMode && (!formView || !!drawHintFor(tool, editing))

  // What the empty bar says while the map is being drawn on: the gesture to
  // use. The area's own card shows its size.
  const drawHint = drawHintFor(tool, editing)

  // What the empty bar says. Before the first question: a rotating suggestion
  // (Tab fills it in). During a conversation: the step the agent is on, or,
  // once idle, the conversation and what it found. Typing replaces either.
  const shownCount = useMemo(
    () => visibleScenes(scenes, timeRange, satelliteFilter).length,
    [scenes, timeRange, satelliteFilter],
  )
  const status = streaming
    ? `${waiting ? waitingText(waiting) : activeActivity(timeline)}…`
    : [
        title || "New session",
        scenes.length
          ? shownCount === scenes.length
            ? sceneCount(scenes.length, moreScenes)
            : `${shownCount.toLocaleString("en")} of ${sceneCount(scenes.length, moreScenes)}`
          : null,
        chosenCount ? `${chosenCount.toLocaleString("en")} selected` : null,
      ]
        .filter(Boolean)
        .join(" · ")

  return (
    // The shell itself takes no pointer events: below 1024px it also holds the
    // legend strip, and the map beside the strip must still pan. Its height is
    // capped so the strip stays on screen under an open panel; the panel
    // shrinks instead. Its width leaves 3.125rem at the right on narrow
    // screens: the GitHub link (2.625rem) and an 8px gap, on the same row.
    <div
      ref={shellRef}
      className="pointer-events-none absolute top-4 left-4 z-30 flex max-h-[calc(100vh-2rem)] w-[40rem] max-w-[calc(100vw-2rem-3.125rem)] flex-col gap-2"
    >
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 520, damping: 40 }}
        role="dialog"
        aria-label="Command palette"
        // Open, the panel covers the map's left side: camera fits frame the
        // footprints in the map to its right. Shrunk, only the bar counts
        // (the input row's own top inset).
        data-map-inset={expanded ? "left" : undefined}
        className={[
          "bx-surface-strong bx-halo-soft pointer-events-auto flex flex-col overflow-hidden rounded-xl text-fg",
          expanded ? "max-h-[min(32rem,calc(100vh-2rem))] shadow-2xl" : "shadow-lg",
        ].join(" ")}
      >
        {/* Input row: tile mark (the spinner while the agent works) or the command icon, breadcrumb, query with ghost text, send (open only) or stop. */}
        <div data-map-inset="top" className="flex items-center gap-2 px-3">
          {commandMode ? (
            <IconTerminal2 size={15} className="shrink-0 text-fg-faint" />
          ) : placeMode ? (
            <IconMapPinSearch size={15} className="shrink-0 text-fg-faint" />
          ) : formView ? (
            <IconFilter size={15} className="shrink-0 text-action" />
          ) : (
            <TileMark busy={streaming} />
          )}
          {formView && (
            <button
              type="button"
              onClick={() => setView("main")}
              title="Back to the session (Esc)"
              className="shrink-0 rounded-md bg-surface-inset px-2 py-0.5 text-xs font-medium text-fg-muted hover:text-fg"
            >
              {view === "query" ? (editingTurn !== null ? "Edit query" : "Query") : "Archive"}
            </button>
          )}
          {trail.map((t, i) => (
            <button
              key={path[i]}
              type="button"
              onClick={() => popTo(i + 1)}
              className="max-w-40 shrink-0 truncate rounded-md bg-surface-inset px-2 py-0.5 text-xs font-medium text-fg-muted hover:text-fg"
            >
              {t}
            </button>
          ))}
          <div className="relative min-w-0 flex-1">
            {showGhost && drawHint && (
              <span
                aria-live="polite"
                className="pointer-events-none absolute inset-y-0 left-0 flex max-w-full items-center truncate text-[13px] text-fg-muted"
              >
                <span className="truncate">{drawHint}</span>
              </span>
            )}
            {showGhost && !drawHint && hasConversation && (!expanded || streaming) && (
              <span
                aria-live="polite"
                className="pointer-events-none absolute inset-y-0 left-0 flex max-w-full items-center gap-2 truncate text-[13px] text-fg-muted"
              >
                <span className="truncate">{status}</span>
              </span>
            )}
            {showGhost && !drawHint && !hasConversation && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-0 flex max-w-full items-center truncate text-[13px] text-fg-faint transition-opacity duration-200"
                style={{ opacity: areaName || suggestionVisible ? 1 : 0 }}
              >
                {areaName ? `Ask about ${areaName}…` : suggestion}
                {expanded && !areaName && (
                  <span className="ml-2 hidden shrink-0 sm:inline">
                    <Key>Tab</Key>
                  </span>
                )}
              </span>
            )}
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                const typed = e.target.value
                setRecentActive(-1)
                if (!formView && !path.length) {
                  // ? typed first in the bar opens the query form; \a the
                  // archive; \n a new session.
                  if (QUERY_KEYS.includes(typed)) {
                    openQueryForm()
                    return
                  }
                  if (typed === `${SHORTCUT_PREFIX}a`) {
                    setQuery("")
                    openArchive()
                    return
                  }
                  if (typed === `${SHORTCUT_PREFIX}n` && !streaming) {
                    setQuery("")
                    setTab("conversation")
                    newConversation()
                    return
                  }
                }
                setQuery(typed)
                expand()
              }}
              onFocus={expand}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              aria-label={
                view === "query"
                  ? "Filter satellites and products"
                  : view === "archive"
                    ? "Filter the archive"
                    : commandMode
                      ? "Command"
                      : placeMode
                        ? "Search for a place"
                        : "Ask for scenes over a place and dates"
              }
              role="combobox"
              aria-expanded={expanded}
              aria-controls={listMode ? LIST_ID : recentShown ? RECENT_ID : undefined}
              aria-activedescendant={
                listMode && activeItem
                  ? `palette-${activeItem.id}`
                  : recentIndex >= 0
                    ? recentOptionId(recent[recentIndex]!.id)
                    : undefined
              }
              autoComplete="off"
              spellCheck={false}
              className="relative h-10 w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-faint"
            />
          </div>
          {(page?.loading || (placeMode && placeSearch.status === "loading")) && (
            <IconLoader2 size={16} className="shrink-0 animate-spin text-fg-faint" />
          )}
          {!listMode && !formView && streaming && (
            <button
              type="button"
              onClick={stop}
              aria-label="Stop"
              className="flex size-5 shrink-0 items-center justify-center rounded-md bg-surface-inset text-fg hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus-ring"
            >
              <IconPlayerStopFilled size={10} />
            </button>
          )}
          {/* Send only while open: collapsed, Enter is enough and the bar stays quiet. */}
          {expanded && !listMode && !formView && !streaming && (
            <button
              type="button"
              onClick={() => query.trim() && ask(query.trim())}
              disabled={!query.trim()}
              aria-label="Send"
              className="flex size-5 shrink-0 items-center justify-center rounded-md bg-action text-on-action disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-focus-ring"
            >
              <IconArrowUp size={11} />
            </button>
          )}
          {!expanded && (
            <span className="hidden shrink-0 sm:inline">
              <Key>Ctrl K</Key>
            </span>
          )}
        </div>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="panel"
              initial={PANEL_SHUT}
              animate={PANEL_OPEN}
              exit={PANEL_SHUT}
              transition={{ duration: 0.18 }}
              // Camera fits wait while it opens or shrinks (afterInsetsSettle).
              // After the shrink the mark stays until the panel leaves the
              // page: it still covers the map for a frame or two after its
              // animation ends.
              onAnimationStart={() => panelRef.current?.setAttribute("data-map-moving", "")}
              onAnimationComplete={(done) => {
                if (done !== PANEL_SHUT) panelRef.current?.removeAttribute("data-map-moving")
              }}
              ref={panelRef}
              className="flex min-h-0 flex-1 flex-col border-t border-border-default"
            >
              {view === "query" ? (
                <div className="flex min-h-0 flex-1 flex-col" style={{ maxHeight: "26rem" }}>
                  <QueryForm filter={query} />
                </div>
              ) : view === "archive" ? (
                <div className="flex min-h-0 flex-1 flex-col" style={{ maxHeight: "26rem" }}>
                  <ArchiveView filter={query} />
                </div>
              ) : listMode ? (
                <div ref={listRef} id={LIST_ID} role="listbox" className="max-h-[20rem] overflow-y-auto p-1.5">
                  {page?.error && <p className="px-3 py-6 text-center text-sm text-danger">{page.error}</p>}
                  {page?.onSubmit && (
                    <p className="px-3 py-6 text-center text-sm text-fg-faint">
                      Type and press <Key>↵</Key> to {page.submitLabel ?? "submit"}.
                    </p>
                  )}
                  {places?.message && <p className="px-3 py-6 text-center text-sm text-fg-faint">{places.message}</p>}
                  {!places && !page?.error && !page?.onSubmit && !matches.length && (
                    <p className="px-3 py-8 text-center text-sm text-fg-faint">
                      {page?.loading ? "Loading…" : "No matches."}
                    </p>
                  )}
                  {placeMode && showSections && matches.length > 0 && (
                    <div className="px-3 pt-1 pb-1 text-[11px] font-medium tracking-wide text-fg-faint uppercase">
                      Recent places
                    </div>
                  )}
                  {matches.map(({ item, labelPositions }, index) => {
                    const section =
                      !placeMode && showSections && item.section !== matches[index - 1]?.item.section
                        ? item.section
                        : null
                    const isActive = index === active
                    return (
                      <Fragment key={item.id}>
                        {section && (
                          <div className="px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide text-fg-faint uppercase first:pt-1">
                            {section}
                          </div>
                        )}
                        <div
                          id={`palette-${item.id}`}
                          role="option"
                          aria-selected={isActive}
                          aria-disabled={item.disabled || undefined}
                          data-index={index}
                          onMouseMove={() => !item.disabled && setActive(index)}
                          onClick={(e) => choose(index, e.shiftKey)}
                          className={[
                            "flex min-h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1 text-[13px] select-none",
                            isActive && !item.disabled ? "bg-surface-inset text-fg" : "text-fg-muted",
                            item.disabled ? "opacity-45" : "",
                          ].join(" ")}
                        >
                          {item.icon && (
                            <span className="flex size-4 shrink-0 items-center justify-center text-fg-faint">
                              {item.icon}
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              <Highlighted text={item.label} positions={labelPositions} />
                            </span>
                            {item.detail && <span className="block truncate text-[11px] text-fg-faint">{item.detail}</span>}
                          </span>
                          {item.hint && <span className="shrink-0 font-mono text-xs text-fg-faint">{item.hint}</span>}
                          {item.pageId && <IconChevronRight size={14} className="shrink-0 text-fg-faint" />}
                        </div>
                      </Fragment>
                    )
                  })}
                </div>
              ) : hasConversation ? (
                <>
                  <div className="flex shrink-0 items-center gap-2 border-b border-border-default py-1 pr-1 pl-2">
                    <Tabs
                      tab={tab}
                      setTab={setTab}
                      count={scenes.length ? `${scenes.length.toLocaleString("en")}${moreScenes ? "+" : ""}` : ""}
                    />
                    <span className="min-w-0 flex-1 truncate text-right text-xs text-fg-faint" title={title}>
                      {title}
                    </span>
                    {conversationId && (
                      <button
                        type="button"
                        aria-label="Session actions"
                        title="Rename, fork, delete"
                        onClick={() => openAt(["conversations", convPage(conversationId)])}
                        className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-faint hover:bg-surface-inset hover:text-fg focus-visible:outline-2 focus-visible:outline-focus-ring"
                      >
                        <IconDots size={16} />
                      </button>
                    )}
                  </div>
                  {/* Both tabs get the same height, so switching between them
                      never resizes the panel. 25rem is what the Scenes tab
                      needs: the date overview sits above the rows, and with
                      less the scene cards' dates start below the fold. On a
                      short window it shrinks with the panel. */}
                  <div className="flex min-h-0 flex-col" style={{ flex: "0 1 25rem" }}>
                    {tab === "conversation" ? <Transcript /> : <ScenesView />}
                  </div>
                </>
              ) : (
                <>
                  <p className="px-3.5 py-4 text-[13px] text-fg-muted">
                    Ask for scenes over a place and a date range, in plain words.
                  </p>
                  <Recent
                    conversations={recent}
                    retentionDays={retentionDays}
                    active={recentIndex}
                    onActive={setRecentActive}
                    onOpen={(id) => {
                      setRecentActive(-1)
                      void openConversation(id)
                    }}
                  />
                </>
              )}

              {/* Key hints: those that do not fit move to a second line. */}
              <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-default px-3 py-1.5 text-[10px] text-fg-faint">
                {formView ? (
                  <>
                    {view === "query" && (
                      <span className="flex items-center gap-1">
                        <Key>↵</Key> run
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Key>esc</Key> back to the session
                    </span>
                  </>
                ) : placeMode ? (
                  <>
                    {places?.canSearch ? (
                      <span className="flex items-center gap-1">
                        <Key>↵</Key> search
                      </span>
                    ) : (
                      matches.length > 0 && (
                        <>
                          <span className="flex items-center gap-1">
                            <Key>↑</Key>
                            <Key>↓</Key> move
                          </span>
                          <span className="flex items-center gap-1">
                            <Key>↵</Key> 10 km around it
                          </span>
                          <span className="flex items-center gap-1">
                            <Key>⇧ ↵</Key> its whole outline
                          </span>
                        </>
                      )
                    )}
                  </>
                ) : commandMode ? (
                  <>
                    <span className="flex items-center gap-1">
                      <Key>↑</Key>
                      <Key>↓</Key> move
                    </span>
                    {page?.onSubmit ? (
                      <span className="flex items-center gap-1">
                        <Key>↵</Key> {page.submitLabel ?? "submit"}
                      </span>
                    ) : (
                      (activeItem?.pageId || activeItem?.run) && (
                        <span className="flex items-center gap-1">
                          <Key>↵</Key> {activeItem.pageId ? "open" : "run"}
                        </span>
                      )
                    )}
                    {path.length > 0 && (
                      <span className="flex items-center gap-1">
                        <Key>⌫</Key> back
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="flex items-center gap-1">
                      <Key>&gt;</Key> commands
                    </span>
                    <span className="flex items-center gap-1">
                      <Key>@</Key> places
                    </span>
                    <span className="flex items-center gap-1">
                      <Key>?</Key> query
                    </span>
                    <span className="flex items-center gap-1">
                      <Key>\n</Key> new
                    </span>
                  </>
                )}
                <span className="ml-auto flex items-center gap-1">
                  <Key>esc</Key> {formView ? "twice to close" : "close"}
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      <LegendStrip />
    </div>
  )
}
