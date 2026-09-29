import { useEffect } from "react"
import type * as maplibregl from "maplibre-gl"
import { useMap } from "./MapProvider"
import { useChatStore } from "@/features/chat/store"
import { env } from "@/lib/env"
import { useQuicklookStore } from "./quicklook"

// Drapes the selected scene's quicklook over its footprint.
// The image goes through the /quicklook proxy (ISRO host sends no CORS
// headers) and is handed to MapLibre as a blob: URL; ImageSource mangles a
// cross-path proxy URL and fails its file:// guard.

const SOURCE_ID = "quicklook"
const LAYER_ID = "quicklook-raster"

// ImageSource wants [TL, TR, BR, BL]; the footprint ring is [NW, NE, SE, SW,
// close], so the first four map directly.
function imageCoords(
  footprint: GeoJSON.Polygon,
): [[number, number], [number, number], [number, number], [number, number]] | null {
  const ring = footprint.coordinates[0]
  if (!ring || ring.length < 4) return null
  const [nw, ne, se, sw] = ring
  if (!nw || !ne || !se || !sw) return null
  return [
    [nw[0]!, nw[1]!],
    [ne[0]!, ne[1]!],
    [se[0]!, se[1]!],
    [sw[0]!, sw[1]!],
  ]
}

function proxied(url: string): string {
  return `${env.agentApiUrl}/quicklook?url=${encodeURIComponent(url)}`
}

function removeDrape(map: maplibregl.Map) {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID)
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
  useQuicklookStore.getState().setDraped(null)
}

// The layer's opacity from the quicklook controls: the slider, or 0 while
// hidden with O.
function shownOpacity(): number {
  const q = useQuicklookStore.getState()
  return q.visible ? q.opacity / 100 : 0
}

export function useQuicklookLayer() {
  const { map } = useMap()
  const scenes = useChatStore((s) => s.scenes)
  const selectedSceneId = useChatStore((s) => s.selectedSceneId)

  useEffect(() => {
    if (!map) return

    let cancelled = false
    let objectUrl: string | null = null

    const clear = () => {
      removeDrape(map)
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        objectUrl = null
      }
    }

    const apply = async () => {
      // Remove any prior drape first.
      removeDrape(map)

      if (!selectedSceneId) return
      const scene = scenes.find((s) => s.id === selectedSceneId)
      if (!scene?.footprint || !scene.quicklook_url) return
      const coords = imageCoords(scene.footprint)
      if (!coords) return

      // blob: URL avoids MapLibre's file:// guard on the proxy URL.
      try {
        const res = await fetch(proxied(scene.quicklook_url))
        if (!res.ok || cancelled) return
        const blob = await res.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)

        map.addSource(SOURCE_ID, { type: "image", url: objectUrl, coordinates: coords })
        // Below the footprint layers so the selected outline stays visible.
        const before = map.getLayer("scenes-fill") ? "scenes-fill" : undefined
        map.addLayer(
          {
            id: LAYER_ID,
            type: "raster",
            source: SOURCE_ID,
            paint: { "raster-opacity": shownOpacity(), "raster-fade-duration": 200 },
          },
          before,
        )
        useQuicklookStore.getState().setDraped(scene.id)
      } catch {
        // Footprint stays drawn on fetch failure.
      }
    }

    void apply()

    return () => {
      cancelled = true
      clear()
    }
  }, [map, selectedSceneId, scenes])

  // The slider and O change the drape in place, without fetching it again.
  const opacity = useQuicklookStore((s) => s.opacity)
  const visible = useQuicklookStore((s) => s.visible)
  useEffect(() => {
    if (map?.getLayer(LAYER_ID)) map.setPaintProperty(LAYER_ID, "raster-opacity", shownOpacity())
  }, [map, opacity, visible])
}
