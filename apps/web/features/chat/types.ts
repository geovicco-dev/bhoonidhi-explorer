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
  total?: number
  returned?: number
  // True when more scenes match than the API returns (1,000, newest first).
  more_available?: boolean
  scenes?: Scene[]
}

// "176 scenes", or "1,000+ scenes (newest 1,000 shown)" when more matched
// than were returned. The API never counts past its limit.
export function sceneCount(n: number, more: boolean): string {
  const plural = n === 1 ? "" : "s"
  return more ? `${n.toLocaleString("en")}+ scenes (newest ${n.toLocaleString("en")} shown)` : `${n.toLocaleString("en")} scene${plural}`
}
