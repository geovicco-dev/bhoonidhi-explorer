import { useEffect } from "react"
import type * as maplibregl from "maplibre-gl"
import { useMap } from "@/features/map/MapProvider"
import { afterInsetsSettle, mapInsets } from "@/features/map/insets"
import { resolveColor } from "@/features/map/color"
import { useChatStore } from "@/features/chat/store"
import { aoiBounds, aoiRing } from "./geo"
import { useAoiStore } from "./store"
import type { Aoi, AoiColor, AoiStyle } from "./types"

// Draws the area of interest: a dashed outline edged by a faint dark casing
// that dashes in step with it, so it reads on imagery and on both basemaps,
// and an optional light fill. Always drawn above the scene footprints.

const SOURCE_ID = "aoi"
const FILL_ID = "aoi-fill"
const CASING_ID = "aoi-casing"
const LINE_ID = "aoi-line"
const LAYERS = [FILL_ID, CASING_ID, LINE_ID]

export const AOI_COLOR_TOKEN: Record<AoiColor, string> = {
  red: "--bx-red-500",
  amber: "--bx-amber-400",
  sky: "--bx-sky-400",
  white: "--bx-white",
}
const CASING_TOKEN = "--bx-slate-950"

// Dash and gap in pixels. MapLibre scales a dash pattern by the line's width,
// so each layer divides by its own width; the casing then dashes in step with
// the line and the gaps stay clear instead of showing the casing.
const DASH_PX = [5, 3]
const SOLID = [1, 0]

// Pixels kept free under a fitted area for its size card (card plus its gap).
const CARD_ROOM = 32

function dashes(style: AoiStyle, width: number): number[] {
  return style.line === "dashed" ? DASH_PX.map((px) => px / width) : SOLID
}

function toData(aoi: Aoi | null): GeoJSON.FeatureCollection {
  if (!aoi) return { type: "FeatureCollection", features: [] }
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [aoiRing(aoi)] } }],
  }
}

function paint(map: maplibregl.Map, style: AoiStyle, hover: boolean) {
  const color = resolveColor(AOI_COLOR_TOKEN[style.color])
  const width = hover ? 3 : 2
  const casing = width + 2
  map.setPaintProperty(LINE_ID, "line-color", color)
  map.setPaintProperty(LINE_ID, "line-width", width)
  map.setPaintProperty(LINE_ID, "line-dasharray", dashes(style, width))
  map.setPaintProperty(CASING_ID, "line-color", resolveColor(CASING_TOKEN))
  map.setPaintProperty(CASING_ID, "line-width", casing)
  map.setPaintProperty(CASING_ID, "line-dasharray", dashes(style, casing))
  map.setPaintProperty(FILL_ID, "fill-color", color)
  map.setPaintProperty(FILL_ID, "fill-opacity", style.fill === "light" ? 0.12 : 0)
}

function ensureLayers(map: maplibregl.Map, data: GeoJSON.FeatureCollection) {
  const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined
  if (source) {
    source.setData(data)
    return
  }
  map.addSource(SOURCE_ID, { type: "geojson", data })
  map.addLayer({ id: FILL_ID, type: "fill", source: SOURCE_ID, paint: { "fill-opacity": 0 } })
  map.addLayer({
    id: CASING_ID,
    type: "line",
    source: SOURCE_ID,
    layout: { "line-join": "round" },
    paint: { "line-opacity": 0.35, "line-width": 4 },
  })
  map.addLayer({
    id: LINE_ID,
    type: "line",
    source: SOURCE_ID,
    layout: { "line-join": "round" },
    paint: { "line-width": 2 },
  })
}

// Layers added later (scene footprints) land on top; move the area back up.
function raise(map: maplibregl.Map) {
  const order = map.getLayersOrder()
  if (order.slice(-LAYERS.length).join() === LAYERS.join()) return
  for (const id of LAYERS) if (map.getLayer(id)) map.moveLayer(id)
}

export function useAoiLayer() {
  const { map } = useMap()
  const aoi = useAoiStore((s) => s.aoi)
  const draft = useAoiStore((s) => s.draft)
  const style = useAoiStore((s) => s.style)
  const hover = useAoiStore((s) => s.hover)
  const flyRequest = useAoiStore((s) => s.flyRequest)
  const scenes = useChatStore((s) => s.scenes)

  const shown = draft ?? aoi

  useEffect(() => {
    if (!map) return
    ensureLayers(map, toData(shown))
    raise(map)
  }, [map, shown])

  useEffect(() => {
    if (!map) return
    ensureLayers(map, toData(useAoiStore.getState().draft ?? useAoiStore.getState().aoi))
    paint(map, style, hover)
  }, [map, style, hover])

  // Runs after the scene layer's own effect (MapCanvas calls that hook first),
  // so a first search's footprints are already added when this raises the area.
  useEffect(() => {
    if (map?.getLayer(LINE_ID)) raise(map)
  }, [map, scenes])

  // A theme switch carries the layers into the new style with colours resolved
  // for the old theme.
  useEffect(() => {
    if (!map) return
    const refeed = () => {
      const s = useAoiStore.getState()
      ensureLayers(map, toData(s.draft ?? s.aoi))
      paint(map, s.style, s.hover)
      raise(map)
    }
    map.on("style.load", refeed)
    return () => {
      map.off("style.load", refeed)
    }
  }, [map])

  useEffect(() => {
    if (!map || flyRequest === 0) return
    const s = useAoiStore.getState()
    const target = s.flyTarget ?? s.aoi
    if (!target) return
    const [w, south, e, n] = aoiBounds(target)
    // Once the floating UI has come to rest: the area commands shrink the
    // palette as they fly, and the legend strip rides up under it.
    return afterInsetsSettle(() => {
      // Room under the shape for its size card.
      const padding = mapInsets(map.getContainer())
      padding.bottom += CARD_ROOM
      map.fitBounds(
        [
          [w, south],
          [e, n],
        ],
        { padding, maxZoom: 13, duration: 800 },
      )
    })
  }, [map, flyRequest])
}
