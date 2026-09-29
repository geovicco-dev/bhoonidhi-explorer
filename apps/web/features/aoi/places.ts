import { create } from "zustand"
import { api, type Place } from "@/features/chat/stream"
import { useAoiStore } from "./store"
import { boxFromCorners, circleAt, DEFAULT_RADIUS_KM } from "./geo"
import type { Aoi } from "./types"

// Place search behind "@" in the palette. Enter searches (Nominatim's policy
// forbids search-as-you-type), then a result becomes the area: a circle of the
// `bhd` default radius on the place, or with Shift its bounding box, which
// suits a district or state. "@lat, lon" skips the lookup. Recent places are
// kept per browser.

const RECENT_KEY = "bhoonidhi.recentPlaces"
const RECENT_MAX = 6

export const PLACE_PREFIX = "@"

// "25.58, 91.89" or "25.58 91.89", latitude first as maps usually show it.
const COORDS = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/

export function parseCoords(text: string): { lat: number; lon: number } | null {
  const m = text.match(COORDS)
  if (!m) return null
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}

export function coordsPlace(lat: number, lon: number): Place {
  const label = `${lat.toFixed(4)}, ${lon.toFixed(4)}`
  const box = circleAt([lon, lat], DEFAULT_RADIUS_KM)
  const d = DEFAULT_RADIUS_KM / 111.32
  return {
    name: label,
    detail: "Coordinates",
    kind: "point",
    lat: box.lat,
    lon: box.lon,
    bbox: { west: lon - d, south: lat - d, east: lon + d, north: lat + d },
  }
}

// The area a place becomes: a circle of the `bhd` default radius on the
// place's point, or its bounding box.
function placeArea(place: Place, asBox = false): Aoi {
  if (!asBox) return circleAt([place.lon, place.lat], DEFAULT_RADIUS_KM, place.name)
  const b = place.bbox
  return boxFromCorners([b.west, b.south], [b.east, b.north], place.name)
}

function loadRecent(): Place[] {
  if (typeof window === "undefined") return []
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown
    return Array.isArray(list) ? (list as Place[]).slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

type PlaceState = {
  // The text the current results are for; results are stale once the query differs.
  searched: string
  results: Place[]
  status: "idle" | "loading" | "done" | "error"
  error: string | null
  recent: Place[]
  search: (text: string) => Promise<void>
  clear: () => void
  // Make the place the area of interest and fly there: a default circle, or
  // with `asBox` the place's bounding box.
  choose: (place: Place, asBox: boolean) => void
}

let requestSeq = 0

export const usePlaceStore = create<PlaceState>()((set, get) => ({
  searched: "",
  results: [],
  status: "idle",
  error: null,
  recent: loadRecent(),

  search: async (text) => {
    const q = text.trim()
    if (q.length < 2) return
    const seq = ++requestSeq
    set({ searched: q, status: "loading", error: null, results: [] })
    try {
      const { places } = await api.geocode(q)
      if (seq !== requestSeq) return
      set({ results: places, status: "done" })
    } catch (err) {
      if (seq !== requestSeq) return
      set({ status: "error", error: (err as Error).message })
    }
  },

  clear: () => {
    requestSeq++
    set({ searched: "", results: [], status: "idle", error: null })
  },

  choose: (place, asBox) => {
    const aoi = useAoiStore.getState()
    aoi.commit(placeArea(place, asBox))
    aoi.flyTo()
    const recent = [place, ...get().recent.filter((p) => p.detail !== place.detail || p.name !== place.name)].slice(
      0,
      RECENT_MAX,
    )
    set({ recent })
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
    } catch {
      // Recent places are a convenience.
    }
  },
}))
