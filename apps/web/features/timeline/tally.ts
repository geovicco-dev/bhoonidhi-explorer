import type { Scene } from "@/features/chat/types"
import { parseSceneDate, readableSatellite } from "./aggregate"
import { buildTree, OTHERS, SEP, sceneKeys, type TreeNode } from "./hierarchy"

// How many scenes a result holds per day (or per month for a long result),
// in all and per row of the Scenes tab: a satellite code, a satellite's
// sensor, or one of its products ("R2A", "R2A/LISS3", "R2A/LISS3/L2"). Made
// from the result's own scenes when it holds every match, or from the STAC
// API's counts when more match than one search returns. The overview graph,
// the rows and their numbers all read a tally, so both kinds of result draw
// the same way.

// [first ms of the period, scenes], oldest first.
export type Series = Array<[number, number]>

export interface Tally {
  // Every scene once, per period.
  all: Series
  // Per row key. A scene filed under two products counts in each of them.
  rows: Map<string, Series>
  // The rows' tree, newest satellite first, with every scene's count.
  tree: TreeNode[]
  // The product values (SELECTION) under each sensor and product key, for
  // asking the STAC API for a row's scenes. Empty for a tally of scenes.
  tokens: Map<string, string[]>
  step: "day" | "month"
  total: number
  // The days of the oldest and newest scene (ms), or null with no scenes.
  first: number | null
  last: number | null
}

function sorted(m: Map<number, number>): Series {
  return [...m.entries()].sort((a, b) => a[0] - b[0])
}

function add(into: Map<number, number>, ms: number, n: number) {
  into.set(ms, (into.get(ms) ?? 0) + n)
}

function merge(a: Series, b: Series): Series {
  const m = new Map<number, number>()
  for (const [ms, n] of [...a, ...b]) add(m, ms, n)
  return sorted(m)
}

export function tallyFromScenes(scenes: Scene[]): Tally {
  const all = new Map<number, number>()
  const rows = new Map<string, Map<number, number>>()
  let first: number | null = null
  let last: number | null = null
  let total = 0
  for (const s of scenes) {
    const ms = parseSceneDate(s.date_of_pass)
    if (ms === null) continue
    total += 1
    first = first === null ? ms : Math.min(first, ms)
    last = last === null ? ms : Math.max(last, ms)
    add(all, ms, 1)
    for (const key of sceneKeys(s)) {
      let m = rows.get(key)
      if (!m) rows.set(key, (m = new Map()))
      add(m, ms, 1)
    }
  }
  return {
    all: sorted(all),
    rows: new Map([...rows].map(([k, m]) => [k, sorted(m)])),
    tree: buildTree(scenes, readableSatellite),
    tokens: new Map(),
    step: "day",
    total,
    first,
    last,
  }
}

// The STAC API's answer to /scenes/counts.
export interface CountsReply {
  status: "ok"
  total: number
  oldest: string | null
  newest: string | null
  interval: "day" | "month" | "week" | "year"
  periods: Array<[string, number]>
  satellites: Record<
    string,
    { total: number; periods: Array<[string, number]>; products: Record<string, { total: number; periods: Array<[string, number]> }> }
  >
}

const day = (iso: string) => {
  const d = new Date(iso)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
const series = (periods: Array<[string, number]>): Series => periods.map(([k, n]) => [day(k), n] as [number, number])

// NovaSAR's "All" product repeats scenes filed under its named products and
// gets no row of its own.
const catchAll = (sensor: string) => sensor.endsWith("(All)")

export function tallyFromCounts(reply: CountsReply): Tally {
  const rows = new Map<string, Series>()
  const tokens = new Map<string, string[]>()
  const sensorSums = new Map<string, Map<number, number>>()
  const tree: TreeNode[] = []
  // Newest first at every level, as the rows of a scene list read.
  const newest = (s: Series) => (s.length ? s[s.length - 1]![0] : -Infinity)
  const sats = Object.entries(reply.satellites).sort(([, a], [, b]) => newest(series(b.periods)) - newest(series(a.periods)))
  for (const [code, sat] of sats) {
    rows.set(code, series(sat.periods))
    let label = code
    const sensors = new Map<string, TreeNode>()
    const products = Object.entries(sat.products).sort(([, a], [, b]) => newest(series(b.periods)) - newest(series(a.periods)))
    for (const [token, p] of products) {
      const parts = token.split("_")
      const sensor = parts[1] || "Unknown"
      if (catchAll(sensor)) continue
      label = label === code ? parts[0] || code : label
      const product = parts.slice(2).join("_") || OTHERS
      const sensorKey = `${code}${SEP}${sensor}`
      const productKey = `${sensorKey}${SEP}${product}`
      const s = series(p.periods)
      const merged = rows.get(productKey)
      rows.set(productKey, merged ? merge(merged, s) : s)
      for (const key of [sensorKey, productKey]) tokens.set(key, [...(tokens.get(key) ?? []), token])
      let sum = sensorSums.get(sensorKey)
      if (!sum) sensorSums.set(sensorKey, (sum = new Map()))
      for (const [ms, n] of s) add(sum, ms, n)
      let node = sensors.get(sensorKey)
      if (!node) sensors.set(sensorKey, (node = { key: sensorKey, label: sensor, count: 0, children: [] }))
      node.count += p.total
      const leaf = node.children.find((c) => c.key === productKey)
      if (leaf) leaf.count += p.total
      else node.children.push({ key: productKey, label: product, count: p.total, children: [] })
    }
    tree.push({ key: code, label, count: sat.total, children: [...sensors.values()] })
  }
  for (const [key, sum] of sensorSums) rows.set(key, sorted(sum))
  return {
    all: series(reply.periods),
    rows,
    tree,
    tokens,
    step: reply.interval === "day" ? "day" : "month",
    total: reply.total,
    first: reply.oldest ? day(reply.oldest) : null,
    last: reply.newest ? day(reply.newest) : null,
  }
}

// The same tally limited to the days [start, end] (ms, both inclusive).
// Exact for a tally kept per day; one kept per month keeps every month the
// days reach into.
export function sliceTally(t: Tally, range: [number, number]): Tally {
  const from = (ms: number) => {
    if (t.step === "day") return ms
    const d = new Date(ms)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  }
  const cut = (s: Series) => s.filter(([ms]) => ms >= from(range[0]) && ms <= range[1])
  const all = cut(t.all)
  return {
    ...t,
    all,
    rows: new Map([...t.rows].map(([k, s]) => [k, cut(s)])),
    total: all.reduce((a, [, n]) => a + n, 0),
    first: all[0]?.[0] ?? null,
    last: all.at(-1)?.[0] ?? null,
  }
}

// The chosen rows without any that sit under another chosen row.
export function topChosen(chosen: string[]): string[] {
  return chosen.filter((k) => !chosen.some((o) => o !== k && k.startsWith(o + SEP)))
}

// Scenes of the chosen rows (every scene when none are chosen), per period.
export function chosenSeries(t: Tally, chosen: string[]): Series {
  const keys = topChosen(chosen)
  if (!keys.length) return t.all
  const m = new Map<number, number>()
  for (const k of keys) for (const [ms, n] of t.rows.get(k) ?? []) add(m, ms, n)
  return sorted(m)
}

// How many scenes the chosen rows hold (every scene when none are chosen).
export function chosenTotal(t: Tally, chosen: string[]): number {
  return chosenSeries(t, chosen).reduce((a, [, n]) => a + n, 0)
}

// Each series summed into `bounds` ([start, end) ms per period), counting
// only periods that fall inside `extent` ([first ms, last ms], inclusive). A
// series kept per month counts a month that starts before the extent but
// reaches into it, in the first period.
export function intoBounds(
  s: Series,
  bounds: Array<[number, number]>,
  extent: [number, number],
  step: "day" | "month" = "day",
): number[] {
  const out = new Array<number>(bounds.length).fill(0)
  if (!bounds.length) return out
  for (const [start, n] of s) {
    if (start > extent[1]) continue
    if (start < extent[0]) {
      const d = new Date(start)
      if (step === "day" || Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) <= extent[0]) continue
    }
    const ms = Math.max(start, extent[0])
    let lo = 0
    let hi = bounds.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (bounds[mid]![0] <= ms) lo = mid
      else hi = mid - 1
    }
    out[lo]! += n
  }
  return out
}

// The rows the STAC API is asked for: each chosen satellite whole, and each
// chosen sensor or product as its satellite with the product values under it.
export function rowsOf(t: Tally, chosen: string[]): Array<{ satellite: string; selections?: string[] }> {
  return topChosen(chosen).map((key) => {
    const satellite = key.split(SEP)[0]!
    return key.includes(SEP) ? { satellite, selections: t.tokens.get(key) ?? [] } : { satellite }
  })
}
