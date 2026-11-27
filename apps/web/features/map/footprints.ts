import type { Scene } from "@/features/chat/types"

// Plane geometry on footprint rings in longitude and latitude, enough for
// telling which footprints hold a clicked point and which is the smaller.

type Ring = GeoJSON.Position[]

function outerRing(footprint: GeoJSON.Polygon): Ring {
  return footprint.coordinates[0] ?? []
}

// Ray casting: whether the point lies inside the ring.
function ringContains(ring: Ring, lon: number, lat: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number]
    const [xj, yj] = ring[j] as [number, number]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function footprintContains(scene: Scene, lon: number, lat: number): boolean {
  return !!scene.footprint && ringContains(outerRing(scene.footprint), lon, lat)
}

// The ring's area in square degrees, for comparing footprint sizes.
export function footprintArea(scene: Scene): number {
  if (!scene.footprint) return Infinity
  const ring = outerRing(scene.footprint)
  let twice = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number]
    const [xj, yj] = ring[j] as [number, number]
    twice += xj * yi - xi * yj
  }
  return Math.abs(twice) / 2
}

// The scene a click on stacked footprints opens. `hits` are the footprints
// under the click in the strip's order, newest first. The product with the
// smallest footprints wins, so a small scene is never out of reach under a
// large one, and of that product the newest scene.
export function sceneToOpen(hits: Scene[]): Scene | undefined {
  const newestOfProduct = new Map<string, Scene>()
  for (const s of hits) {
    const product = s.selection ?? s.collection ?? s.satellite ?? ""
    if (!newestOfProduct.has(product)) newestOfProduct.set(product, s)
  }
  let best: Scene | undefined
  for (const s of newestOfProduct.values()) {
    if (!best || footprintArea(s) < footprintArea(best)) best = s
  }
  return best
}
