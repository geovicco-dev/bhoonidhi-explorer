import type { AgentEvent } from "@/features/chat/types"
import { aoiCenter, boxFromCorners, circleAt, containsLonLat, MAX_RADIUS_KM, MIN_RADIUS_KM, sameGround } from "./geo"
import type { Aoi } from "./types"

// How the agent's work moves the area of interest: a place it resolves becomes
// the area, and a search over other ground replaces it with what was searched.
// Used while streaming, and to rebuild the area of conversations saved without one.

// search_scenes, an older tool that searched the live portal, still appears in
// saved conversations.
const SEARCH_TOOLS = new Set(["search_catalog", "search_scenes"])

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

// Nominatim names are long ("Shillong, Mylliem, East Khasi Hills, …"); the
// first part is the place itself.
function shortName(name: unknown): string | undefined {
  return typeof name === "string" && name.trim() ? name.split(",")[0]!.trim() : undefined
}

function resolvedPlace(result: unknown): Aoi | null {
  if (!result || typeof result !== "object") return null
  const r = result as { found?: unknown; name?: unknown; bbox?: Record<string, unknown> }
  if (r.found !== true || !r.bbox) return null
  const [w, s, e, n] = [num(r.bbox.minx), num(r.bbox.miny), num(r.bbox.maxx), num(r.bbox.maxy)]
  if (w === null || s === null || e === null || n === null) return null
  return boxFromCorners([w, s], [e, n], shortName(r.name))
}

// The ground a search covered: a box (minx..maxy) or a circle (lat, lon,
// radius_km; 10 km when the radius is left out, as the API does).
function searchedArea(args: Record<string, unknown>): Aoi | null {
  const [lat, lon, r] = [num(args.lat), num(args.lon), num(args.radius_km)]
  if (lat !== null && lon !== null) {
    const radius = r ?? 10
    if (radius < MIN_RADIUS_KM || radius > MAX_RADIUS_KM) return null
    return circleAt([lon, lat], radius)
  }
  const [w, s, e, n] = [num(args.minx), num(args.miny), num(args.maxx), num(args.maxy)]
  if (w === null || s === null || e === null || n === null || w >= e || s >= n) return null
  return boxFromCorners([w, s], [e, n])
}

// The area after this event, or null when the event leaves it as it is.
export function areaAfter(event: AgentEvent, current: Aoi | null): Aoi | null {
  if (event.type === "area") return event.area
  if (event.type === "tool_result" && event.name === "resolve_location") return resolvedPlace(event.result)
  if (event.type === "tool_call" && SEARCH_TOOLS.has(event.name)) {
    const searched = searchedArea(event.arguments)
    if (!searched || (current && sameGround(current, searched))) return null
    // A search that still covers the named place's centre keeps the name.
    return current?.name && containsLonLat(searched, aoiCenter(current)) ? { ...searched, name: current.name } : searched
  }
  return null
}

// Replays every stored event to find the area a conversation ended with.
export function areaFromTurns(turns: { events: AgentEvent[] }[]): Aoi | null {
  let area: Aoi | null = null
  for (const t of turns) {
    for (const e of t.events) area = areaAfter(e, area) ?? area
  }
  return area
}
