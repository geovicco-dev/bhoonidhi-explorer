import { useEffect, useMemo } from "react"
import { useChatStore, visibleScenes } from "@/features/chat/store"
import type { Scene } from "@/features/chat/types"
import { useScene, useSceneSource } from "@/features/timeline/whole"
import { isTypingTarget } from "@/lib/typing"

// Stepping through the scenes of one footprint: the scenes on the map in the
// open scene's grid cell (its path and row, or its tile), whichever
// satellite took them. The map shows what the Scenes tab shows, so the rows
// and dates chosen there decide what the steps go through, and scrolling the
// strip further adds the scenes it loads.

export type CellSteps = {
  // 1 for the oldest scene of the cell, `total` for the newest.
  position: number
  total: number
  older: Scene | null
  newer: Scene | null
}

export function useCellSteps(scene: Scene | undefined): CellSteps | null {
  const source = useSceneSource()
  const timeRange = useChatStore((s) => s.timeRange)
  const satelliteFilter = useChatStore((s) => s.satelliteFilter)
  return useMemo(() => {
    const cell = scene?.grid_cell
    if (!scene || !cell) return null
    // The strip's order, newest first.
    const same = visibleScenes(source, timeRange, satelliteFilter).filter((s) => s.grid_cell === cell)
    const at = same.findIndex((s) => s.id === scene.id)
    if (at < 0 || same.length < 2) return null
    return {
      position: same.length - at,
      total: same.length,
      older: same[at + 1] ?? null,
      newer: same[at - 1] ?? null,
    }
  }, [scene, source, timeRange, satelliteFilter])
}

// Comma steps to the older scene of the open footprint and full stop to the
// newer one, wherever its card is, unless focus is in a text field. Holding
// the key down steps once.
export function useCellStepKeys() {
  const selected = useScene(useChatStore((s) => s.selectedSceneId))
  const steps = useCellSteps(selected)
  const openOnMap = useChatStore((s) => s.openOnMap)
  useEffect(() => {
    if (!steps) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== "," && e.key !== ".") return
      const range = e.target instanceof HTMLInputElement && e.target.type === "range"
      if (isTypingTarget(e.target) && !range) return
      e.preventDefault()
      const to = e.key === "," ? steps.older : steps.newer
      if (to) openOnMap(to.id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [steps, openOnMap])
}
