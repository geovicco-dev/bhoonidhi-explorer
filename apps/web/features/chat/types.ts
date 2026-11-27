// SSE event shapes streamed by apps/api /chat; mirror the Python agent loop.

import type { Aoi } from "@/features/aoi/types"
import type { Query } from "@/features/query/store"

export type AgentEvent =
  | { type: "turn"; idx: number }
  // The question is in line for the model: its place (1 = next) and the
  // server's estimate of the seconds until it starts.
  | { type: "waiting"; position: number; wait_s: number }
  // The area of interest the user's message was sent with.
  | { type: "area"; area: Aoi }
  // A turn run from the query form, without the agent: the query itself.
  | { type: "query"; query: Query }
  | { type: "agent"; text: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "answer"; text: string }
  | { type: "error"; message: string }
  | { type: "done" }

// Scene as returned by the API's search_catalog; only UI-read fields typed.
export interface Scene {
  id: string
  // Catalogue collection id, e.g. "sentinel-2b-msi".
  collection?: string
  satellite?: string
  sensor?: string
  // ISRO product token, e.g. "Sentinel-2B_MSI_Level-2A"; first segment is the
  // readable satellite name.
  selection?: string
  date_of_pass?: string
  availability?: "Ready" | "Archived" | "OnOrder" | "Priced"
  downloadable?: boolean
  // Ground resolution in metres, from the catalogue's gsd.
  gsd_m?: number | null
  footprint?: GeoJSON.Polygon | null
  center?: { lat: number; lon: number } | null
  // Public quicklook JPEG on the ISRO portal, or null.
  quicklook_url?: string | null
}

export interface SearchResult {
  status?: string
  // Every scene that matches; "N+" only when the STAC API could not count.
  count?: number | string
  total?: number
  returned?: number
  // True when more scenes match than the search returns (the newest 1,000).
  more_available?: boolean
  // The dates of the oldest and newest match, as the portal writes them.
  oldest?: string
  newest?: string
  scenes?: Scene[]
  // The STAC search that found the scenes, for asking the explorer's API for
  // the result's counts and further pages. Results saved before it existed
  // have none.
  search?: Record<string, unknown> | null
}

// "176 scenes", or "1,000+ scenes (newest 1,000 shown)" for a result saved
// before the explorer counted past the scenes it returned.
export function sceneCount(n: number, more: boolean): string {
  const plural = n === 1 ? "" : "s"
  return more ? `${n.toLocaleString("en")}+ scenes (newest ${n.toLocaleString("en")} shown)` : `${n.toLocaleString("en")} scene${plural}`
}
