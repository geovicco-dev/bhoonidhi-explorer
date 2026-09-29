import { useEffect } from "react"
import { dismissPalette, usePaletteStore } from "@/features/palette/store"
import { isTypingTarget } from "@/lib/typing"
import { useAoiStore } from "./store"
import type { DrawTool } from "./types"

// Keys for the area of interest, unless focus is in a text field: R and P arm
// a mode, Esc disarms or finishes, Enter ends editing, Delete removes the area
// while its actions or edit mode show, Ctrl/Cmd+Z undoes, and with Shift redoes.

export function armTool(tool: DrawTool) {
  const s = useAoiStore.getState()
  s.setTool(s.tool === tool ? null : tool)
  dismissPalette()
}

// The draw button: arm the last-used mode, or disarm whatever is armed.
export function toggleDraw() {
  const s = useAoiStore.getState()
  s.setTool(s.tool ? null : s.mode)
  dismissPalette()
}

// Enter should not finish editing through a focused button.
function onMapOrPage(target: EventTarget | null): boolean {
  return target === document.body || (target instanceof Element && !!target.closest(".maplibregl-map"))
}

export function useAoiShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return
      const s = useAoiStore.getState()
      const key = e.key.toLowerCase()

      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        if (key === "z") {
          e.preventDefault()
          if (e.shiftKey) s.redo()
          else s.undo()
        } else if (key === "y" && !e.shiftKey) {
          e.preventDefault()
          s.redo()
        }
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === "Escape") {
        // An open palette takes Esc for itself.
        if (usePaletteStore.getState().expanded) return
        if (s.tool) s.setTool(null)
        else if (s.editing) s.setEditing(false)
        else if (s.menuOpen) s.setMenuOpen(false)
        else return
        e.preventDefault()
        return
      }
      if (e.repeat) return

      if (!e.shiftKey && (key === "r" || key === "p")) {
        e.preventDefault()
        armTool(key === "r" ? "rectangle" : "point")
      } else if ((e.key === "Delete" || e.key === "Backspace") && s.aoi && (s.menuOpen || s.editing)) {
        e.preventDefault()
        s.commit(null)
      } else if (e.key === "Enter" && s.editing && onMapOrPage(e.target)) {
        e.preventDefault()
        s.setEditing(false)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}
