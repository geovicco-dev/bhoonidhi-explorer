import type { Scene } from "@/features/chat/types"
import { chosenSeries, intoBounds, type Tally } from "./tally"

// Two views of a result's dates, both read from a tally (tally.ts).
// `overview` counts the scenes of the chosen rows (every scene when none are
// chosen) across the whole result: the graph at the top of the Scenes tab.
// `aggregateScenes` sets the periods of the rows below it and each
// satellite's colour; it covers the chosen dates only and uses a finer step
// as the window shrinks (years, months, weeks, then days).

export interface TimelineRow {
  id: string
  label: string
  color: string
}

interface Aggregation {
  rows: TimelineRow[]
  buckets: string[]
  /** [startMs, endMs) for each bucket, index-aligned with `buckets`. */
  bucketBounds: Array<[number, number]>
  /** The dates the matrix covers: [first ms, last ms], both inclusive. */
  extent: [number, number]
}

export const DAY_MS = 86_400_000
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const MONTH_INDEX: Record<string, number> = Object.fromEntries(
  MONTHS.map((m, i) => [m.toLowerCase(), i]),
)

// Series colours, a light and a dark one per row; the design system has no
// series tokens. Dark mode uses the bright 300 steps of the theme's ramps, and
// oklch mixes of them for the in-between hues: 10 to 12:1 on the dark grid at
// full strength and about 6:1 halfway.
const PALETTE: ReadonlyArray<readonly [light: string, dark: string]> = [
  ["#3d6b4f", "var(--bx-green-300)"],
  ["#3d5a6b", "var(--bx-sky-300)"],
  ["#6b5a3d", "var(--bx-amber-300)"],
  ["#5a3d6b", "color-mix(in oklch, var(--bx-sky-300), var(--bx-red-300))"],
  ["#6b3d4f", "var(--bx-red-300)"],
  ["#3d6b6b", "color-mix(in oklch, var(--bx-green-300), var(--bx-sky-300))"],
  ["#6b6b3d", "color-mix(in oklch, var(--bx-green-300), var(--bx-amber-300))"],
  ["#4f3d6b", "color-mix(in oklch, var(--bx-sky-300) 70%, var(--bx-red-300))"],
]

// The `selection` token leads with the ISRO display name, so its first segment
// is the label without a hardcoded code map.
export function readableSatellite(scene: Scene): string {
  const seg = (scene.selection ?? "").split("_")[0]
  return seg || scene.satellite || "Unknown"
}

// "01-Jan-2024" → UTC ms, or null.
export function parseSceneDate(s: string | undefined): number | null {
  if (!s) return null
  const parts = s.split("-")
  if (parts.length !== 3) return null
  const day = Number(parts[0])
  const mon = MONTH_INDEX[(parts[1] ?? "").toLowerCase()]
  const year = Number(parts[2])
  if (!Number.isFinite(day) || mon === undefined || !Number.isFinite(year)) return null
  return Date.UTC(year, mon, day)
}

// "12 Mar 2021".
export function formatDay(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

// A scene's date as "12 Mar 2021"; a date that does not parse is shown as stored.
export function sceneDate(scene: Scene): string {
  const ms = parseSceneDate(scene.date_of_pass)
  return ms === null ? (scene.date_of_pass ?? "") : formatDay(ms)
}

// How long a stretch of time is, in the unit a person would use for it.
export function spanText(ms: number): string {
  const days = Math.max(1, Math.round(ms / DAY_MS))
  if (days < 62) return `${days} ${days === 1 ? "day" : "days"}`
  if (days < 730) return `${Math.round(days / 30.44)} months`
  return `${(days / 365.25).toFixed(1).replace(/\.0$/, "")} years`
}

export type Granularity = "day" | "week" | "month" | "year"

function granularityFor(spanDays: number, kept: "day" | "month"): Granularity {
  if (spanDays <= 62 && kept === "day") return "day"
  if (spanDays <= 200 && kept === "day") return "week"
  if (spanDays <= 1100) return "month"
  return "year"
}

// Weeks count from `origin` (the first day shown), so the first column starts
// on the first day rather than on a Monday before it.
function bucketStart(ms: number, g: Granularity, origin: number): number {
  const d = new Date(ms)
  if (g === "day") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  if (g === "week") return origin + Math.floor((ms - origin) / (7 * DAY_MS)) * 7 * DAY_MS
  if (g === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  return Date.UTC(d.getUTCFullYear(), 0, 1)
}
function bucketEnd(startMs: number, g: Granularity): number {
  const d = new Date(startMs)
  if (g === "day") return startMs + DAY_MS
  if (g === "week") return startMs + 7 * DAY_MS
  if (g === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  return Date.UTC(d.getUTCFullYear() + 1, 0, 1)
}
function bucketLabel(startMs: number, g: Granularity): string {
  const d = new Date(startMs)
  if (g === "day" || g === "week") return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]}`
  if (g === "month") return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  return `${d.getUTCFullYear()}`
}

// `window` ([start, end] in ms, both inclusive) limits the matrix to those
// dates and sets its step from their span; null covers every scene. The rows
// are the result's satellites, each with a colour that stays put whatever
// the dates; their counts come from rowCounts (drill.ts), for whichever rows
// show.
export function aggregateScenes(
  base: Tally,
  window: [number, number] | null = null,
  theme: "light" | "dark" = "dark",
  kept: "day" | "month" = base.step,
): Aggregation | null {
  if (base.first === null || base.last === null) return null

  const minMs = window ? window[0] : base.first
  const maxMs = window ? window[1] : base.last + DAY_MS - 1
  const g = granularityFor((maxMs - minMs) / DAY_MS, kept)
  const origin = bucketStart(minMs, "day", minMs)

  // Contiguous buckets so gaps read as empty cells.
  const bounds: Array<[number, number]> = []
  const labels: string[] = []
  let cursor = bucketStart(minMs, g, origin)
  const lastStart = bucketStart(maxMs, g, origin)
  while (cursor <= lastStart) {
    const end = bucketEnd(cursor, g)
    bounds.push([cursor, end])
    labels.push(bucketLabel(cursor, g))
    cursor = end
  }

  // Row id is the raw satellite code, the first part of every row key below
  // it; the label is the readable name.
  const rows: TimelineRow[] = base.tree.map((node, i) => ({
    id: node.key,
    label: node.label,
    color: PALETTE[i % PALETTE.length]![theme === "light" ? 0 : 1],
  }))

  return { rows, buckets: labels, bucketBounds: bounds, extent: [minMs, maxMs] }
}

export interface Overview {
  /** From the first scene's day to the end of the last scene's day: [start, end). */
  extent: [number, number]
  /** Scenes of the chosen rows (every scene when none are chosen) per
   *  period, index-aligned with `bounds`. */
  counts: number[]
  bounds: Array<[number, number]>
  step: Granularity
}

// Scenes counted per day (spans up to four months), per week (up to about
// three years), per month (up to 33 years) or per year beyond that. The
// dates and periods always come from every scene, so choosing satellites
// changes only the counts and the window over the graph stays put.
export function overview(t: Tally, chosen: string[] = []): Overview | null {
  if (t.first === null || t.last === null) return null
  const { first, last } = t
  const spanDays = (last - first) / DAY_MS
  let step: Granularity = spanDays <= 120 ? "day" : spanDays <= 1000 ? "week" : spanDays <= 12_000 ? "month" : "year"
  // A tally kept per month has nothing finer to show.
  if (t.step === "month" && (step === "day" || step === "week")) step = "month"
  const bounds: Array<[number, number]> = []
  let cursor = bucketStart(first, step, first)
  while (cursor <= last) {
    const end = bucketEnd(cursor, step)
    bounds.push([cursor, end])
    cursor = end
  }
  const counts = intoBounds(chosenSeries(t, chosen), bounds, [-Infinity, Infinity])
  return { extent: [first, last + DAY_MS], counts, bounds, step }
}

// One overview period in words: "12 Mar 2022", "week of 12 Mar 2022",
// "Mar 2022" or "2022".
export function stepLabel(start: number, step: Granularity): string {
  const d = new Date(start)
  if (step === "day") return formatDay(start)
  if (step === "week") return `week of ${formatDay(start)}`
  if (step === "month") return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  return String(d.getUTCFullYear())
}

// Year starts (or month starts, for spans under two and a half years) between
// two dates, thinned to at most `max`, for the overview's axis.
export function axisTicks(start: number, end: number, max = 7): { ms: number; label: string }[] {
  const s = new Date(start)
  const years = (end - start) / (365.25 * DAY_MS)
  const out: { ms: number; label: string }[] = []
  if (years > 2.5) {
    const every = Math.max(1, Math.ceil(years / max))
    for (let y = s.getUTCFullYear() + 1; ; y++) {
      const ms = Date.UTC(y, 0, 1)
      if (ms >= end) break
      if (y % every === 0) out.push({ ms, label: String(y) })
    }
    return out
  }
  const every = Math.max(1, Math.ceil((years * 12) / max))
  for (let i = 1; ; i++) {
    const ms = Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + i, 1)
    if (ms >= end) break
    const month = new Date(ms).getUTCMonth()
    if (month % every === 0) out.push({ ms, label: month === 0 ? String(new Date(ms).getUTCFullYear()) : MONTHS[month]! })
  }
  return out
}
