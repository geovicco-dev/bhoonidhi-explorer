import { create } from "zustand"
import { sameAoi } from "./geo"
import type { Aoi, AoiStyle, DrawTool } from "./types"

// The area of interest: one at a time, with undo and redo over every change,
// so deleting needs no confirmation. `draft` is the shape mid-drag; the map
// shows it, and only the release commits it to history.

const HISTORY = 50
const STYLE_KEY = "bhoonidhi.aoiStyle"
const MODE_KEY = "bhoonidhi.aoiDrawMode"

const DEFAULT_STYLE: AoiStyle = { color: "red", line: "dashed", fill: "none" }

function loadStyle(): AoiStyle {
  if (typeof window === "undefined") return DEFAULT_STYLE
  try {
    const saved = JSON.parse(localStorage.getItem(STYLE_KEY) ?? "null") as Partial<AoiStyle> | null
    return { ...DEFAULT_STYLE, ...(saved ?? {}) }
  } catch {
    return DEFAULT_STYLE
  }
}

function loadMode(): DrawTool {
  if (typeof window === "undefined") return "rectangle"
  try {
    return localStorage.getItem(MODE_KEY) === "point" ? "point" : "rectangle"
  } catch {
    return "rectangle"
  }
}

// Menus and edit mode close whenever the area goes away.
const closed = { editing: false, menuOpen: false, styleOpen: false }

type AoiState = {
  aoi: Aoi | null
  draft: Aoi | null
  past: (Aoi | null)[]
  future: (Aoi | null)[]
  // Armed drawing tool; the next press on the map draws with it.
  tool: DrawTool | null
  // The mode the draw button arms: the last one used, kept per browser.
  mode: DrawTool
  // Handles and typed fields are showing; the area takes pointer input.
  editing: boolean
  // The area's actions (Edit, Style, Zoom, Delete) are showing.
  menuOpen: boolean
  styleOpen: boolean
  style: AoiStyle
  // Pointer is over the outline (thicker line, pointer cursor).
  hover: boolean
  // A counter, so asking twice flies twice. flyTarget is a place to show
  // without making it the area; null means the area itself.
  flyRequest: number
  flyTarget: Aoi | null
  // The typed fields should take focus (edit mode started from the keyboard).
  focusFields: boolean

  setDraft: (draft: Aoi | null) => void
  commit: (next: Aoi | null) => void
  // Replace without history, for opening or starting a conversation.
  reset: (aoi: Aoi | null) => void
  undo: () => void
  redo: () => void
  setTool: (tool: DrawTool | null) => void
  setEditing: (editing: boolean, focusFields?: boolean) => void
  setMenuOpen: (open: boolean) => void
  setStyleOpen: (open: boolean) => void
  setStyle: (patch: Partial<AoiStyle>) => void
  setHover: (hover: boolean) => void
  flyTo: (target?: Aoi | null) => void
}

export const useAoiStore = create<AoiState>()((set, get) => ({
  aoi: null,
  draft: null,
  past: [],
  future: [],
  tool: null,
  mode: loadMode(),
  ...closed,
  style: loadStyle(),
  hover: false,
  flyRequest: 0,
  flyTarget: null,
  focusFields: false,

  setDraft: (draft) => set({ draft }),

  commit: (next) => {
    const { aoi, past } = get()
    if (sameAoi(aoi, next) && aoi?.name === next?.name) {
      set({ draft: null })
      return
    }
    set({
      aoi: next,
      draft: null,
      past: [...past, aoi].slice(-HISTORY),
      future: [],
      ...(next ? {} : closed),
    })
  },

  reset: (aoi) => set({ aoi, draft: null, past: [], future: [], tool: null, ...closed }),

  undo: () => {
    const { aoi, past, future } = get()
    if (!past.length) return
    const prev = past[past.length - 1] ?? null
    set({ aoi: prev, draft: null, past: past.slice(0, -1), future: [aoi, ...future], ...(prev ? {} : closed) })
  },

  redo: () => {
    const { aoi, past, future } = get()
    if (!future.length) return
    const next = future[0] ?? null
    set({ aoi: next, draft: null, past: [...past, aoi], future: future.slice(1), ...(next ? {} : closed) })
  },

  setTool: (tool) => {
    set({ tool, draft: null, ...closed, ...(tool ? { mode: tool } : {}) })
    if (!tool) return
    try {
      localStorage.setItem(MODE_KEY, tool)
    } catch {
      // The mode still applies for this visit.
    }
  },

  setEditing: (editing, focusFields = false) => {
    if (editing && !get().aoi) return
    set({ editing, menuOpen: false, styleOpen: false, tool: null, focusFields: editing && focusFields })
  },

  setMenuOpen: (open) => set({ menuOpen: open && !!get().aoi, styleOpen: false }),

  setStyleOpen: (styleOpen) => set({ styleOpen }),

  setStyle: (patch) => {
    const style = { ...get().style, ...patch }
    set({ style })
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify(style))
    } catch {
      // A private window may refuse storage; the style still applies now.
    }
  },

  setHover: (hover) => {
    if (get().hover !== hover) set({ hover })
  },

  flyTo: (target = null) => set((s) => ({ flyTarget: target, flyRequest: s.flyRequest + 1 })),
}))
