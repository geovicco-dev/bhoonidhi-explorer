import { useEffect, useRef } from "react"
import type * as maplibregl from "maplibre-gl"
import { useMap } from "./MapProvider"
import { useChatStore } from "@/features/chat/store"
import { useCellSteps } from "@/features/scene/cellSteps"
import { useScene } from "@/features/timeline/whole"
import { env } from "@/lib/env"
import { useQuicklookStore } from "./quicklook"
import { CHOSEN_LINE_ID } from "./useSceneLayer"

// Drapes the selected scene's quicklook over its footprint.
// The image goes through the /quicklook proxy (ISRO host sends no CORS
// headers) and is handed to MapLibre as a blob: URL; ImageSource mangles a
// cross-path proxy URL and fails its file:// guard.
//
// Two layers take turns, so the next scene's quicklook fades in over the
// last one instead of the map going blank while it loads. The quicklooks of
// the scenes ‹ and › lead to are fetched ahead, so a step shows at once.

const SLOTS = ["quicklook-a", "quicklook-b"] as const
type Slot = (typeof SLOTS)[number]
const FADE_MS = 300
// How long the last quicklook stays while the next one loads; after that it
// fades out, so a slow image never leaves the old one over another place.
const HOLD_MS = 500
const CACHE_SIZE = 8

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

// Quicklook images by their URL, as blob: URLs, the most recent few kept.
// A blob: URL a layer still draws is never revoked: a theme switch loads
// the layer's image again from it.
const cache = new Map<string, Promise<string>>()
const drawing = new Map<Slot, string>()

function quicklookBlob(url: string): Promise<string> {
  const hit = cache.get(url)
  if (hit) {
    cache.delete(url)
    cache.set(url, hit)
    return hit
  }
  const loading = fetch(proxied(url))
    .then((res) => {
      if (!res.ok) throw new Error(`quicklook ${res.status}`)
      return res.blob()
    })
    .then((blob) => URL.createObjectURL(blob))
  loading.catch(() => cache.delete(url))
  cache.set(url, loading)
  for (const [key, old] of cache) {
    if (cache.size <= CACHE_SIZE) break
    cache.delete(key)
    old
      .then((blob) => {
        if (![...drawing.values()].includes(blob)) URL.revokeObjectURL(blob)
      })
      .catch(() => {})
  }
  return loading
}

// The layer's opacity from the quicklook controls: the slider, or 0 while
// hidden with O.
function shownOpacity(): number {
  const q = useQuicklookStore.getState()
  return q.visible ? q.opacity / 100 : 0
}

function removeSlot(map: maplibregl.Map, slot: Slot) {
  if (map.getLayer(slot)) map.removeLayer(slot)
  if (map.getSource(slot)) map.removeSource(slot)
  drawing.delete(slot)
}

function fadeTo(map: maplibregl.Map, slot: Slot, opacity: number, ms: number) {
  if (!map.getLayer(slot)) return
  map.setPaintProperty(slot, "raster-opacity-transition", { duration: ms, delay: 0 })
  map.setPaintProperty(slot, "raster-opacity", opacity)
}

// Calls `done` once the slot's image has loaded, or after a short wait at
// most.
function whenLoaded(map: maplibregl.Map, slot: Slot, done: () => void) {
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    map.off("sourcedata", onData)
    window.clearTimeout(timer)
    done()
  }
  const onData = (e: maplibregl.MapSourceDataEvent) => {
    if (e.sourceId === slot && map.isSourceLoaded(slot)) finish()
  }
  map.on("sourcedata", onData)
  const timer = window.setTimeout(finish, 600)
}

export function useQuicklookLayer() {
  const { map } = useMap()
  const selectedSceneId = useChatStore((s) => s.selectedSceneId)
  const selected = useScene(selectedSceneId)
  const steps = useCellSteps(selected)
  // The slot that holds the quicklook shown now, and whose scene it is.
  const shown = useRef<{ slot: Slot; id: string } | null>(null)

  useEffect(() => {
    if (!map) return
    let cancelled = false
    const timers: number[] = []
    const removeLater = (slot: Slot) =>
      timers.push(window.setTimeout(() => shown.current?.slot !== slot && removeSlot(map, slot), FADE_MS + 50))

    const fadeOutShown = () => {
      const was = shown.current
      if (!was) return
      shown.current = null
      useQuicklookStore.getState().setDraped(null)
      fadeTo(map, was.slot, 0, FADE_MS)
      removeLater(was.slot)
    }

    const scene = selected
    const coords = scene?.footprint && scene.quicklook_url ? imageCoords(scene.footprint) : null
    if (!scene?.quicklook_url || !coords) {
      fadeOutShown()
      return
    }
    // The same scene again, from a page of scenes coming in.
    if (shown.current?.id === scene.id) return

    const hold = window.setTimeout(fadeOutShown, HOLD_MS)
    timers.push(hold)
    quicklookBlob(scene.quicklook_url)
      .then((url) => {
        if (cancelled) return
        window.clearTimeout(hold)
        const was = shown.current
        const slot: Slot = was?.slot === SLOTS[0] ? SLOTS[1] : SLOTS[0]
        removeSlot(map, slot)
        map.addSource(slot, { type: "image", url, coordinates: coords })
        drawing.set(slot, url)
        // Over the faint outlines of the other scenes and the last
        // quicklook, under the open scene's outline.
        const before = map.getLayer(CHOSEN_LINE_ID) ? CHOSEN_LINE_ID : undefined
        map.addLayer(
          { id: slot, type: "raster", source: slot, paint: { "raster-opacity": 0, "raster-fade-duration": 0 } },
          before,
        )
        shown.current = { slot, id: scene.id }
        useQuicklookStore.getState().setDraped(scene.id)
        whenLoaded(map, slot, () => {
          if (shown.current?.slot !== slot) return
          fadeTo(map, slot, shownOpacity(), FADE_MS)
          if (was) {
            fadeTo(map, was.slot, 0, FADE_MS)
            window.setTimeout(() => shown.current?.slot !== was.slot && removeSlot(map, was.slot), FADE_MS + 50)
          }
        })
      })
      .catch(() => {
        // The footprint stays drawn when the image cannot be fetched.
        if (!cancelled) fadeOutShown()
      })

    return () => {
      cancelled = true
      for (const t of timers) window.clearTimeout(t)
    }
  }, [map, selected])

  // The quicklooks one step older and newer, fetched ahead.
  useEffect(() => {
    for (const s of [steps?.older, steps?.newer]) {
      if (s?.quicklook_url) quicklookBlob(s.quicklook_url).catch(() => {})
    }
  }, [steps])

  // The slider and O change the drape in place, at once.
  const opacity = useQuicklookStore((s) => s.opacity)
  const visible = useQuicklookStore((s) => s.visible)
  useEffect(() => {
    const now = shown.current
    if (map && now) fadeTo(map, now.slot, shownOpacity(), 0)
  }, [map, opacity, visible])
}
