import { useEffect } from "react"
import type * as maplibregl from "maplibre-gl"
import { useMap } from "./MapProvider"
import { mapInsets } from "./insets"
import { resolveColor } from "./color"
import { useChatStore, visibleScenes } from "@/features/chat/store"
import type { Scene } from "@/features/chat/types"
import { AVAILABILITY, AVAILABILITY_ORDER } from "@/features/scene/availability"
import { useQuicklookStore } from "./quicklook"
import { useAoiStore } from "@/features/aoi/store"

// Result layer: filtered scene footprints coloured by availability.
// A new search redraws and reframes; a filter change re-feeds the source
// without moving the camera. While scenes are chosen, only they are drawn
// (the open one in its availability colour, the rest in the selection
// colour), so the open scene's quicklook is not buried.

const SOURCE_ID = "scenes"
const FILL_ID = "scenes-fill"
const LINE_ID = "scenes-line"

const FALLBACK_COLOR = "#64748b" // unknown availability
const SELECTION_TOKEN = "--bx-accent"

function scenesToFeatures(
  scenes: Scene[],
  colors: Record<string, string>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  for (const scene of scenes) {
    if (!scene.footprint) continue
    features.push({
      type: "Feature",
      geometry: scene.footprint,
      properties: {
        id: scene.id,
        availability: scene.availability ?? "Unknown",
        color: colors[scene.availability ?? ""] ?? FALLBACK_COLOR,
      },
    })
  }
  return { type: "FeatureCollection", features }
}

// Bounds of every footprint ring, or null if none.
function boundsOf(fc: GeoJSON.FeatureCollection): maplibregl.LngLatBoundsLike | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const f of fc.features) {
    if (f.geometry.type !== "Polygon") continue
    for (const ring of f.geometry.coordinates) {
      for (const pos of ring) {
        const x = pos[0]
        const y = pos[1]
        if (x === undefined || y === undefined) continue
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (minX === Infinity) return null
  return [
    [minX, minY],
    [maxX, maxY],
  ]
}

// Footprints are filled lightly, except while a quicklook is on the map:
// then only their outlines are drawn, so no tint sits over the image.
function fillOpacity(): number {
  return useQuicklookStore.getState().drapedId ? 0 : 0.15
}

function ensureLayers(map: maplibregl.Map, data: GeoJSON.FeatureCollection) {
  const existing = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined
  if (existing) {
    existing.setData(data)
    if (map.getLayer(FILL_ID)) map.setPaintProperty(FILL_ID, "fill-opacity", fillOpacity())
    return
  }
  map.addSource(SOURCE_ID, { type: "geojson", data })
  map.addLayer({
    id: FILL_ID,
    type: "fill",
    source: SOURCE_ID,
    paint: {
      "fill-color": ["get", "color"],
      "fill-opacity": fillOpacity(),
    },
  })
  map.addLayer({
    id: LINE_ID,
    type: "line",
    source: SOURCE_ID,
    paint: {
      "line-color": ["get", "color"],
      "line-width": 1.5,
      "line-opacity": 0.9,
    },
  })
}

export function useSceneLayer() {
  const { map } = useMap()
  const scenes = useChatStore((s) => s.scenes)
  const timeRange = useChatStore((s) => s.timeRange)
  const satelliteFilter = useChatStore((s) => s.satelliteFilter)
  const selectedSceneId = useChatStore((s) => s.selectedSceneId)
  const chosenIds = useChatStore((s) => s.chosenIds)
  // While the area is drawn or edited, footprints are not drawn, so the
  // basemap under the area shows. They come back when the area is done.
  const shaping = useAoiStore((s) => s.tool !== null || s.editing)
  const finishPlot = useChatStore((s) => s.finishPlot)

  const colorMap = () =>
    Object.fromEntries(
      AVAILABILITY_ORDER.map((state) => [state, resolveColor(AVAILABILITY[state].token)]),
    )

  const drawnFeatures = (): GeoJSON.FeatureCollection => {
    if (shaping) return { type: "FeatureCollection", features: [] }
    if (chosenIds.length) {
      // The open scene in its availability colour, as when it is the only
      // one; the others chosen with it in the selection colour.
      const ids = new Set(chosenIds)
      const selection = resolveColor(SELECTION_TOKEN)
      const open = scenes.filter((s) => s.id === selectedSceneId)
      const others = scenes.filter((s) => ids.has(s.id) && s.id !== selectedSceneId)
      return {
        type: "FeatureCollection",
        features: [
          ...scenesToFeatures(others, Object.fromEntries(AVAILABILITY_ORDER.map((a) => [a, selection]))).features,
          ...scenesToFeatures(open, colorMap()).features,
        ],
      }
    }
    return scenesToFeatures(visibleScenes(scenes, timeRange, satelliteFilter), colorMap())
  }

  // fitBounds runs here only: a new search reframes, filtering does not.
  useEffect(() => {
    if (!map) return

    const apply = () => {
      ensureLayers(map, drawnFeatures())
      const bounds = boundsOf(scenesToFeatures(scenes, colorMap()))
      if (bounds) {
        map.fitBounds(bounds, { padding: mapInsets(map.getContainer()), maxZoom: 9, duration: 600 })
        // Plot step completes once the frame settles.
        map.once("moveend", () => finishPlot())
      } else {
        // Resolve the plot step even with nothing drawable.
        finishPlot()
      }
    }

    apply()
    // Reframe depends on scenes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, scenes])

  // A theme switch swaps the basemap style; the footprint layers are carried
  // over, but their colours were resolved for the old theme. Re-feed on every
  // new style so they pick up the current theme's colours.
  useEffect(() => {
    if (!map) return
    const refeed = () => ensureLayers(map, drawnFeatures())
    map.on("style.load", refeed)
    return () => {
      map.off("style.load", refeed)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, scenes, timeRange, satelliteFilter, chosenIds, selectedSceneId, shaping])

  // Re-feed on filter/selection change without touching the camera.
  useEffect(() => {
    if (!map) return
    ensureLayers(map, drawnFeatures())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, timeRange, satelliteFilter, chosenIds, selectedSceneId, shaping])

  // The fill goes when a quicklook drapes and comes back when it leaves.
  const drapedId = useQuicklookStore((s) => s.drapedId)
  useEffect(() => {
    if (map?.getLayer(FILL_ID)) map.setPaintProperty(FILL_ID, "fill-opacity", fillOpacity())
  }, [map, drapedId])

  // Only on request (Zoom to scene, or the scene card appearing under a shrunk
  // palette), never on selection alone, so browsing the strip does not move
  // the camera. Padding is measured at call time, so it fits the space the
  // floating UI leaves free right now.
  const zoomRequest = useChatStore((s) => s.zoomRequest)
  useEffect(() => {
    if (!map || zoomRequest === 0 || !selectedSceneId) return
    const one = scenes.find((s) => s.id === selectedSceneId)
    if (!one?.footprint) return
    const bounds = boundsOf(scenesToFeatures([one], {}))
    if (bounds) map.fitBounds(bounds, { padding: mapInsets(map.getContainer()), maxZoom: 12, duration: 600 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomRequest])
}
