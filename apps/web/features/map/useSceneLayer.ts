import { useEffect, useRef } from "react"
import type * as maplibregl from "maplibre-gl"
import { useMap } from "./MapProvider"
import { afterInsetsSettle, mapInsets } from "./insets"
import { resolveColor } from "./color"
import { footprintArea } from "./footprints"
import { useChatStore, visibleScenes } from "@/features/chat/store"
import type { Scene } from "@/features/chat/types"
import { AVAILABILITY, AVAILABILITY_ORDER } from "@/features/scene/availability"
import { useChosenScenes, useSceneSource, useStripSettled } from "@/features/timeline/whole"
import { useAoiStore } from "@/features/aoi/store"

// Result layer: the outlines of the scenes the strip shows, coloured by
// availability, with no fill, so overlapping footprints never hide the map.
// A new search redraws and reframes, and so do choosing rows or dates and
// removing the chosen scenes; more strip pages re-feed the source without
// moving the camera. While scenes are chosen, they are drawn on top (the open
// one in its availability colour, the rest in the selection colour) and every
// other footprint stays as a faint outline, so a click on it opens it. The
// open scene's quicklook lies between the two: over the faint outlines, under
// the chosen ones.

const SOURCE_ID = "scenes"
const LINE_ID = "scenes-line"
export const CHOSEN_LINE_ID = "scenes-chosen-line"
// How long the footprints must hold still after the dates or rows change
// before the map refits to them.
const REFIT_SETTLE_MS = 300

const FALLBACK_COLOR = "#64748b" // unknown availability
const SELECTION_TOKEN = "--bx-accent"

// How each footprint is drawn: "shown" with nothing chosen, "faint" beside
// chosen scenes, "chosen" for a chosen scene that is not open, "open".
type Role = "shown" | "faint" | "chosen" | "open"

function scenesToFeatures(
  scenes: Scene[],
  colors: Record<string, string>,
  role: Role = "shown",
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
        role,
        // Larger footprints are drawn first, under the smaller ones.
        order: -footprintArea(scene),
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

function ensureLayers(map: maplibregl.Map, data: GeoJSON.FeatureCollection) {
  const existing = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined
  if (existing) {
    existing.setData(data)
    return
  }
  map.addSource(SOURCE_ID, { type: "geojson", data })
  map.addLayer({
    id: LINE_ID,
    type: "line",
    source: SOURCE_ID,
    filter: ["in", ["get", "role"], ["literal", ["shown", "faint"]]],
    layout: { "line-sort-key": ["get", "order"] },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["match", ["get", "role"], "faint", 1, 1.5],
      "line-opacity": ["match", ["get", "role"], "faint", 0.35, 0.9],
    },
  })
  map.addLayer({
    id: CHOSEN_LINE_ID,
    type: "line",
    source: SOURCE_ID,
    filter: ["in", ["get", "role"], ["literal", ["chosen", "open"]]],
    layout: { "line-sort-key": ["get", "order"] },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["match", ["get", "role"], "open", 2, 1.5],
      "line-opacity": 0.9,
    },
  })
}

export function useSceneLayer() {
  const { map } = useMap()
  const scenes = useChatStore((s) => s.scenes)
  const source = useSceneSource()
  const chosenScenes = useChosenScenes()
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
    const shown = visibleScenes(source, timeRange, satelliteFilter)
    if (!chosenIds.length) return scenesToFeatures(shown, colorMap())
    const selection = resolveColor(SELECTION_TOKEN)
    const chosen = new Set(chosenIds)
    const open = chosenScenes.filter((s) => s.id === selectedSceneId)
    const others = chosenScenes.filter((s) => s.id !== selectedSceneId)
    return {
      type: "FeatureCollection",
      features: [
        ...scenesToFeatures(shown.filter((s) => !chosen.has(s.id)), colorMap(), "faint").features,
        ...scenesToFeatures(others, Object.fromEntries(AVAILABILITY_ORDER.map((a) => [a, selection])), "chosen").features,
        ...scenesToFeatures(open, colorMap(), "open").features,
      ],
    }
  }

  // A new search reframes to every scene it holds.
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
  }, [map, scenes, source, timeRange, satelliteFilter, chosenScenes, selectedSceneId, shaping])

  // Re-feed on filter/selection change without touching the camera.
  useEffect(() => {
    if (!map) return
    ensureLayers(map, drawnFeatures())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, source, timeRange, satelliteFilter, chosenScenes, selectedSceneId, shaping])

  // Choosing rows or dates, or removing the chosen scenes, refits the map to
  // the strip's footprints once those have come and held still, so a drag of
  // the date window fits once, on release. A new search frames itself above,
  // and more strip pages leave the camera where it is. While scenes are
  // chosen or the area is being shaped, the fit waits until the strip's
  // footprints show again.
  const settled = useStripSettled()
  const refit = useRef(false)
  const last = useRef({ scenes, timeRange, satelliteFilter, chosenIds })
  useEffect(() => {
    const was = last.current
    last.current = { scenes, timeRange, satelliteFilter, chosenIds }
    if (was.scenes !== scenes) refit.current = false
    else if (
      was.timeRange !== timeRange ||
      was.satelliteFilter !== satelliteFilter ||
      (was.chosenIds.length > 0 && chosenIds.length === 0)
    )
      refit.current = true
  }, [scenes, timeRange, satelliteFilter, chosenIds])
  useEffect(() => {
    if (!map || !refit.current || !settled || shaping || chosenIds.length) return
    let cancel = () => {}
    const timer = window.setTimeout(() => {
      refit.current = false
      const bounds = boundsOf(scenesToFeatures(visibleScenes(source, timeRange, satelliteFilter), {}))
      if (!bounds) return
      cancel = afterInsetsSettle(() =>
        map.fitBounds(bounds, { padding: mapInsets(map.getContainer()), maxZoom: 9, duration: 600 }),
      )
    }, REFIT_SETTLE_MS)
    return () => {
      window.clearTimeout(timer)
      cancel()
    }
  }, [map, source, timeRange, satelliteFilter, settled, shaping, chosenIds.length])

  // On request (the Zoom button, or the scene card appearing under a shrunk
  // palette after a strip click), never on a footprint click or a step with
  // ‹ ›, so browsing on the map leaves the camera still. Padding is measured
  // once the floating UI has come to rest, so it fits the space the UI
  // leaves free.
  const zoomRequest = useChatStore((s) => s.zoomRequest)
  useEffect(() => {
    if (!map || zoomRequest === 0 || !selectedSceneId) return
    const one = chosenScenes.find((s) => s.id === selectedSceneId) ?? scenes.find((s) => s.id === selectedSceneId)
    if (!one?.footprint) return
    const bounds = boundsOf(scenesToFeatures([one], {}))
    if (!bounds) return
    return afterInsetsSettle(() =>
      map.fitBounds(bounds, { padding: mapInsets(map.getContainer()), maxZoom: 12, duration: 600 }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomRequest])
}
