import { create } from "zustand"

// The palette is the app's one control surface: a bar at the top of the map
// that expands into a panel. Plain text is a question for the agent; a leading
// ">" (or a drilled-in page) switches the input to commands.
//
// `path` holds page ids only; pages are rebuilt from live feature data on
// every render, so a page that is still loading fills in while it is open.
// Any page change starts a fresh query (or the page's pre-fill).
export type PaletteTab = "conversation" | "scenes"

// What the expanded panel shows: the conversation and commands, the query
// form, or the archive browser.
type PaletteView = "main" | "query" | "archive"

type PaletteState = {
  expanded: boolean
  tab: PaletteTab
  view: PaletteView
  path: string[]
  query: string
  active: number
  expand: () => void
  collapse: () => void
  toggle: () => void
  setTab: (tab: PaletteTab) => void
  setView: (view: PaletteView) => void
  // Open straight at a page, e.g. from the conversation title's menu.
  openAt: (path: string[], query?: string) => void
  push: (pageId: string, query?: string) => void
  pop: () => void
  popTo: (depth: number) => void
  setQuery: (query: string) => void
  setActive: (index: number) => void
}

const fresh = { query: "", active: 0 }

export const usePaletteStore = create<PaletteState>()((set) => ({
  expanded: false,
  tab: "conversation",
  view: "main",
  path: [],
  ...fresh,
  expand: () => set({ expanded: true }),
  // Shrinking keeps the query form or the archive open underneath, so drawing
  // an area from the form comes back to it; Esc is what leaves them.
  collapse: () => set({ expanded: false, path: [], ...fresh }),
  toggle: () => set((s) => (s.expanded ? { expanded: false, path: [], ...fresh } : { expanded: true })),
  setTab: (tab) => set({ tab }),
  setView: (view) => set({ view, expanded: true, path: [], ...fresh }),
  openAt: (path, query = "") => set({ expanded: true, path, query, active: 0 }),
  push: (pageId, query = "") => set((s) => ({ path: [...s.path, pageId], query, active: 0 })),
  pop: () => set((s) => ({ path: s.path.slice(0, -1), ...fresh })),
  popTo: (depth) => set((s) => ({ path: s.path.slice(0, depth), ...fresh })),
  setQuery: (query) => set({ query, active: 0 }),
  setActive: (active) => set({ active }),
}))

// Shrink the palette and take focus out of it, so the next keys (Esc, the map
// shortcuts) reach the map. For commands that hand over to the map, and for
// presses that start drawing.
export function dismissPalette() {
  usePaletteStore.getState().collapse()
  const el = document.activeElement
  if (el instanceof HTMLElement && el !== document.body) el.blur()
}
