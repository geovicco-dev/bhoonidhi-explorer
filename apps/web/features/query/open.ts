import { useEffect } from "react"
import { useAoiStore } from "@/features/aoi/store"
import { useChatStore } from "@/features/chat/store"
import { usePaletteStore } from "@/features/palette/store"
import { isTypingTarget } from "@/lib/typing"
import { type Query, queryApi, useQueryStore } from "./store"

// Opens the query form for a new query turn, keeping the fields last used and
// taking the area on the map. While a question waits for the model, the form
// is filled from the question instead (see fromQuestion).
export function openQueryForm() {
  const q = useQueryStore.getState()
  const base = { ...q.query, area: useAoiStore.getState().aoi }
  q.open(base, null)
  usePaletteStore.getState().setView("query")
  const waiting = useChatStore.getState().waiting
  if (waiting) void fillFromQuestion(waiting.text, base)
}

// The nudge: the question waiting for the model, as a form query. What the
// question names plainly (satellites, sensors, levels, months, years,
// "ready", a resolution) is laid over the conversation's last search; the
// area is the one on the map. No model call. Running it takes the question
// out of the line, so the model never answers it.
async function fillFromQuestion(text: string, base: Query) {
  const { query, searchArgs } = lastSearch()
  try {
    const filled = await queryApi.fromQuestion({
      text,
      area: base.area,
      base: query ? { ...query, area: base.area ?? query.area } : base,
      search_args: query ? null : searchArgs,
    })
    // Left alone if the form was edited or closed in the meantime.
    const form = useQueryStore.getState()
    if (form.query === base && usePaletteStore.getState().view === "query") form.open(filled.query, null)
  } catch {
    // The form stays as it opened.
  }
}

// The conversation's most recent search: a query turn's query, or the
// arguments of the agent's last catalogue search.
function lastSearch(): { query: Query | null; searchArgs: Record<string, unknown> | null } {
  const timeline = useChatStore.getState().timeline
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]
    if (!item) continue
    if (item.kind === "message" && item.query) return { query: item.query, searchArgs: null }
    if (item.kind === "tool" && item.name === "search_catalog" && item.args) return { query: null, searchArgs: item.args }
  }
  return { query: null, searchArgs: null }
}

export function openArchive() {
  void useQueryStore.getState().loadProducts()
  usePaletteStore.getState().setView("archive")
}

// Set when the form hands the map over to draw an area or pick a place: the
// next new area brings the form back.
let returnToForm = false

export function setAreaFromForm() {
  returnToForm = true
}

// Q or ? on the map opens the query form, as D, R and P act on the map;
// inside a text field they are typed as usual. In the palette's bar, ? as the
// first character opens it too, the way > opens commands and @ places.
export const QUERY_KEYS = ["?"]

// "\" starts a two-key shortcut typed first in the bar: "\a" opens the
// archive, "\n" starts a new session. On the map, "\" opens the bar with it
// already typed.
export const SHORTCUT_PREFIX = "\\"

export function useQueryShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || isTypingTarget(e.target)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === SHORTCUT_PREFIX) {
        e.preventDefault()
        const palette = usePaletteStore.getState()
        palette.setQuery(SHORTCUT_PREFIX)
        palette.expand()
        return
      }
      if (!(e.key === "q" && !e.shiftKey) && !QUERY_KEYS.includes(e.key)) return
      e.preventDefault()
      openQueryForm()
    }
    window.addEventListener("keydown", onKey)
    // Back to the form once the area is drawn or picked, or the drawing is
    // cancelled with Esc. Deferred, because picking a place shrinks the
    // palette right after setting the area.
    const stopArea = useAoiStore.subscribe((s, prev) => {
      if (!returnToForm) return
      const drawn = s.aoi !== prev.aoi && !!s.aoi
      const cancelled = prev.tool !== null && s.tool === null && s.aoi === prev.aoi
      if (!drawn && !cancelled) return
      returnToForm = false
      setTimeout(() => usePaletteStore.getState().setView("query"), 0)
    })
    // A place search given up with Esc does not bring the form back later.
    const stopPalette = usePaletteStore.subscribe((s, prev) => {
      if (prev.expanded && !s.expanded && s.view === "main" && !useAoiStore.getState().tool) returnToForm = false
    })
    return () => {
      window.removeEventListener("keydown", onKey)
      stopArea()
      stopPalette()
    }
  }, [])
}
