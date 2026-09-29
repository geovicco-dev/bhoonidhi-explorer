import type { Scene } from "@/features/chat/types"

// The footprints of the given scenes as a GeoJSON file, saved by the browser.
// Scenes without a footprint are left out.
export function downloadFootprints(scenes: Scene[]): number {
  const features = scenes
    .filter((s) => s.footprint)
    .map((s) => ({
      type: "Feature" as const,
      geometry: s.footprint!,
      properties: {
        id: s.id,
        satellite: s.satellite ?? null,
        sensor: s.sensor ?? null,
        date: s.date_of_pass ?? null,
        availability: s.availability ?? null,
      },
    }))
  const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features })], { type: "application/geo+json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = "bhoonidhi-footprints.geojson"
  a.click()
  URL.revokeObjectURL(url)
  return features.length
}
