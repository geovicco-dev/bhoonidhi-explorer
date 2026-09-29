import type * as maplibregl from "maplibre-gl"
import type { Aoi, AoiBox, AoiCircle } from "./types"

// Geometry for the area of interest: rings, bounds, sizes, hit tests. Distances
// are great-circle on a spherical Earth, which is well within what a search
// area needs.

export type LonLat = [number, number]

// The portal's point search accepts 1 to 100 km; `bhd` defaults to 10.
export const MIN_RADIUS_KM = 1
export const MAX_RADIUS_KM = 100
export const DEFAULT_RADIUS_KM = 10

// Web Mercator cannot show the poles.
const MAX_LAT = 85

const EARTH_RADIUS_KM = 6371.0088
const rad = (deg: number) => (deg * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const clampLat = (lat: number) => clamp(lat, -MAX_LAT, MAX_LAT)
const clampLon = (lon: number) => clamp(lon, -180, 180)
const clampRadius = (km: number) => clamp(km, MIN_RADIUS_KM, MAX_RADIUS_KM)

export function distanceKm(a: LonLat, b: LonLat): number {
  const dLat = rad(b[1] - a[1])
  const dLon = rad(b[0] - a[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

// The point `km` away from `from` along a bearing (degrees clockwise from north).
export function destination(from: LonLat, km: number, bearing: number): LonLat {
  const d = km / EARTH_RADIUS_KM
  const b = rad(bearing)
  const lat1 = rad(from[1])
  const lon1 = rad(from[0])
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b))
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2))
  return [((deg(lon2) + 540) % 360) - 180, deg(lat2)]
}

// Initial bearing from `from` to `to`, degrees clockwise from north.
export function bearing(from: LonLat, to: LonLat): number {
  const lat1 = rad(from[1])
  const lat2 = rad(to[1])
  const dLon = rad(to[0] - from[0])
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (deg(Math.atan2(y, x)) + 360) % 360
}

const CIRCLE_STEPS = 96

// Closed outline ring. A box needs only its corners: Web Mercator draws lines
// of constant longitude and latitude straight.
export function aoiRing(aoi: Aoi): LonLat[] {
  if (aoi.kind === "bbox") {
    const { west: w, south: s, east: e, north: n } = aoi
    return [
      [w, n],
      [e, n],
      [e, s],
      [w, s],
      [w, n],
    ]
  }
  const center: LonLat = [aoi.lon, aoi.lat]
  const ring: LonLat[] = []
  for (let i = 0; i < CIRCLE_STEPS; i++) ring.push(destination(center, aoi.radius_km, (360 * i) / CIRCLE_STEPS))
  ring.push(ring[0]!)
  return ring
}

// [west, south, east, north]. For a circle, its geodesic extent.
export function aoiBounds(aoi: Aoi): [number, number, number, number] {
  if (aoi.kind === "bbox") return [aoi.west, aoi.south, aoi.east, aoi.north]
  const center: LonLat = [aoi.lon, aoi.lat]
  return [
    destination(center, aoi.radius_km, 270)[0],
    destination(center, aoi.radius_km, 180)[1],
    destination(center, aoi.radius_km, 90)[0],
    destination(center, aoi.radius_km, 0)[1],
  ]
}

export function aoiCenter(aoi: Aoi): LonLat {
  if (aoi.kind === "circle") return [aoi.lon, aoi.lat]
  return [(aoi.west + aoi.east) / 2, (aoi.south + aoi.north) / 2]
}

function formatKm(km: number): string {
  if (km < 1) return `${Math.max(1, Math.round(km * 1000))} m`
  if (km < 10) return `${km.toFixed(1).replace(/\.0$/, "")} km`
  return `${Math.round(km)} km`
}

// Ground area of a box on the sphere: R² · Δλ · (sin φn − sin φs).
function boxAreaKm2(box: { west: number; south: number; east: number; north: number }): number {
  return EARTH_RADIUS_KM ** 2 * rad(box.east - box.west) * (Math.sin(rad(box.north)) - Math.sin(rad(box.south)))
}

function formatKm2(km2: number): string {
  if (km2 < 10) return `${km2.toFixed(1).replace(/\.0$/, "")} km²`
  return `${Math.round(km2).toLocaleString("en")} km²`
}

// Size label: a rectangle by its area ("1,152 km²"), a circle by its radius
// ("r 12 km"), since the radius is what the circle is drawn and searched by.
export function aoiSize(aoi: Aoi): string {
  if (aoi.kind === "circle") return `r ${formatKm(aoi.radius_km)}`
  return formatKm2(boxAreaKm2(aoi))
}

// Spoken form for the label's accessible name.
export function aoiSizeSpoken(aoi: Aoi): string {
  return aoiSize(aoi).replace(/^r /, "radius ").replace(/km²$/, "square kilometres").replace(/km$/, "kilometres")
}

export function boxFromCorners(a: LonLat, b: LonLat, name?: string): AoiBox {
  return {
    kind: "bbox",
    west: clampLon(Math.min(a[0], b[0])),
    east: clampLon(Math.max(a[0], b[0])),
    south: clampLat(Math.min(a[1], b[1])),
    north: clampLat(Math.max(a[1], b[1])),
    ...(name ? { name } : {}),
  }
}

export function circleAt(center: LonLat, radiusKm: number, name?: string): AoiCircle {
  return {
    kind: "circle",
    lon: clampLon(center[0]),
    lat: clampLat(center[1]),
    radius_km: clampRadius(radiusKm),
    ...(name ? { name } : {}),
  }
}

// The area shifted by a lon/lat offset, keeping its size. The name goes: the
// shape no longer outlines that place.
export function moveAoi(aoi: Aoi, dLon: number, dLat: number): Aoi {
  if (aoi.kind === "circle") {
    return { kind: "circle", lon: clampLon(aoi.lon + dLon), lat: clampLat(aoi.lat + dLat), radius_km: aoi.radius_km }
  }
  // Clamp the shift, not the corners, so the box never changes shape at an edge.
  const lon = clamp(dLon, -180 - aoi.west, 180 - aoi.east)
  const lat = clamp(dLat, -MAX_LAT - aoi.south, MAX_LAT - aoi.north)
  return {
    kind: "bbox",
    west: aoi.west + lon,
    east: aoi.east + lon,
    south: aoi.south + lat,
    north: aoi.north + lat,
  }
}

export function sameAoi(a: Aoi | null, b: Aoi | null, tolerance = 1e-6): boolean {
  if (!a || !b) return a === b
  if (a.kind !== b.kind) return false
  const close = (x: number, y: number) => Math.abs(x - y) <= tolerance
  if (a.kind === "bbox" && b.kind === "bbox") {
    return close(a.west, b.west) && close(a.south, b.south) && close(a.east, b.east) && close(a.north, b.north)
  }
  if (a.kind === "circle" && b.kind === "circle") {
    return close(a.lon, b.lon) && close(a.lat, b.lat) && close(a.radius_km, b.radius_km)
  }
  return false
}

export function containsLonLat(aoi: Aoi, p: LonLat): boolean {
  if (aoi.kind === "circle") return distanceKm([aoi.lon, aoi.lat], p) <= aoi.radius_km
  return p[0] >= aoi.west && p[0] <= aoi.east && p[1] >= aoi.south && p[1] <= aoi.north
}

// True when two areas cover about the same ground: every edge of their bounds
// within 10% of the span (or 0.01°). The model rounds coordinates it copies
// (a 5.758 km radius comes back as 5.75811).
export function sameGround(a: Aoi, b: Aoi): boolean {
  const ab = aoiBounds(a)
  const bb = aoiBounds(b)
  const tolLon = Math.max(0.01, 0.1 * Math.abs(ab[2] - ab[0]))
  const tolLat = Math.max(0.01, 0.1 * Math.abs(ab[3] - ab[1]))
  return (
    Math.abs(ab[0] - bb[0]) <= tolLon &&
    Math.abs(ab[2] - bb[2]) <= tolLon &&
    Math.abs(ab[1] - bb[1]) <= tolLat &&
    Math.abs(ab[3] - bb[3]) <= tolLat
  )
}

// The top-centre and bottom-centre points of the outline, where the label and
// the card attach.
export function aoiTopBottom(aoi: Aoi): { top: LonLat; bottom: LonLat } {
  if (aoi.kind === "bbox") {
    const mid = (aoi.west + aoi.east) / 2
    return { top: [mid, aoi.north], bottom: [mid, aoi.south] }
  }
  const c: LonLat = [aoi.lon, aoi.lat]
  return { top: destination(c, aoi.radius_km, 0), bottom: destination(c, aoi.radius_km, 180) }
}

// Map coordinates under a client (viewport) position.
export function lonLatAt(map: maplibregl.Map, clientX: number, clientY: number): LonLat {
  const box = map.getCanvas().getBoundingClientRect()
  const ll = map.unproject([clientX - box.left, clientY - box.top])
  return [clampLon(ll.lng), clampLat(ll.lat)]
}

// --- screen-space hit tests ---------------------------------------------------

type Pt = { x: number; y: number }

function projectRing(map: maplibregl.Map, aoi: Aoi): Pt[] {
  return aoiRing(aoi).map((p) => map.project(p))
}

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = dx * dx + dy * dy
  const t = len ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0, 1) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

// Pixel distance from a map point to the outline.
export function outlineDistance(map: maplibregl.Map, aoi: Aoi, p: Pt): number {
  const ring = projectRing(map, aoi)
  let best = Infinity
  for (let i = 1; i < ring.length; i++) best = Math.min(best, segmentDistance(p, ring[i - 1]!, ring[i]!))
  return best
}

export function insideOnScreen(map: maplibregl.Map, aoi: Aoi, p: Pt): boolean {
  const ring = projectRing(map, aoi)
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!
    const b = ring[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
