import { useEffect, useRef } from "react"
import type * as maplibregl from "maplibre-gl"
import { useMap } from "./MapProvider"
import { footprintContains, sceneToOpen } from "./footprints"
import { useChatStore, visibleScenes } from "@/features/chat/store"
import type { Scene } from "@/features/chat/types"
import { useScene, useSceneSource } from "@/features/timeline/whole"
import { useAoiStore } from "@/features/aoi/store"

// A click on a footprint opens its scene, as a plain click on its strip card
// does, and leaves the camera where it is. A click inside the open scene
// closes it. Where footprints stack, sceneToOpen picks one. The footprints
// are tested in code, not through the map's layers, because the open
// scene's quicklook covers them.
export function useFootprintClick() {
  const { map } = useMap()
  const source = useSceneSource()
  const timeRange = useChatStore((s) => s.timeRange)
  const satelliteFilter = useChatStore((s) => s.satelliteFilter)
  const open = useScene(useChatStore((s) => s.selectedSceneId))
  const shown = useRef<Scene[]>([])
  const opened = useRef<Scene | undefined>(undefined)
  useEffect(() => {
    shown.current = visibleScenes(source, timeRange, satelliteFilter)
    opened.current = open
  }, [source, timeRange, satelliteFilter, open])

  useEffect(() => {
    if (!map) return
    const container = map.getCanvasContainer()
    // Decided as the press starts, before the area's own handlers act on it:
    // a press that draws, edits or opens the area belongs to the area.
    let forFootprints = false
    const onDown = (e: PointerEvent) => {
      const area = useAoiStore.getState()
      forFootprints =
        e.button === 0 &&
        !e.shiftKey &&
        container.contains(e.target as Node) &&
        area.tool === null &&
        !area.editing &&
        !area.hover
    }
    const onClick = (e: maplibregl.MapMouseEvent) => {
      // The second click of a double-click zooms the map; it opens nothing.
      if (!forFootprints || e.originalEvent.detail > 1) return
      forFootprints = false
      const { lng, lat } = e.lngLat
      const chat = useChatStore.getState()
      const now = opened.current
      if (now && footprintContains(now, lng, lat)) {
        chat.closeScene()
        return
      }
      const hit = sceneToOpen(shown.current.filter((s) => footprintContains(s, lng, lat)))
      if (hit) chat.openOnMap(hit.id)
    }
    // Capture phase on the window, so it runs before any handler on the map.
    window.addEventListener("pointerdown", onDown, true)
    map.on("click", onClick)
    return () => {
      window.removeEventListener("pointerdown", onDown, true)
      map.off("click", onClick)
    }
  }, [map])
}
