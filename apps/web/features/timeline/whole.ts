"use client"

import { useEffect, useMemo } from "react"
import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"
import { isPaged, useChatStore, visibleScenes } from "@/features/chat/store"
import { sceneCount, type Scene, type SearchResult } from "@/features/chat/types"
import { env } from "@/lib/env"
import { failure } from "@/lib/http"
import { DAY_MS, parseSceneDate } from "./aggregate"
import { useOpened } from "./drill"
import { SEP } from "./hierarchy"
import { chosenTotal, rowsOf, sliceTally, tallyFromCounts, topChosen, type CountsReply, type Tally } from "./tally"

// The Scenes tab and the map for a result that matched more scenes than one
// search returns. Its counts come from the STAC API (the whole result, per
// period, per satellite and per product), its scenes from pages of the same
// search narrowed to the chosen dates and rows: the newest 100, more as the
// strip scrolls, shown in the strip and on the map alike. A result that
// holds every scene it matched uses its own scenes instead.

export const STRIP_PAGE = 100
// How long the dates and rows must stay put before their scenes load, so a
// drag of the window loads once, on release.
const SETTLE_MS = 300
// A result spanning more days than this is counted per month; its window
// is counted per day once it is this short.
const DAY_STEP_MAX_DAYS = 1_000

export type Counted =
  | { status: "counting" }
  | { status: "ok"; tally: Tally }
  | { status: "too_broad" | "failed"; message: string }

type Slice = { start?: string; end?: string; rows: Array<{ satellite: string; selections?: string[] }> }

interface Whole {
  // The result the state belongs to; null when no result needs it.
  result: SearchResult | null
  base: Counted
  // Counts within the window, for a result counted per month.
  narrow: { key: string; counted: Counted } | null
  strip: { key: string; scenes: Scene[]; next: string | null; loading: boolean; error: string | null } | null
  // Every scene fetched for the result, by id.
  known: Map<string, Scene>
}

const EMPTY: Whole = { result: null, base: { status: "counting" }, narrow: null, strip: null, known: new Map() }
export const useWhole = create<Whole>()(() => EMPTY)

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.agentApiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await failure(res, path)
  return (await res.json()) as T
}

async function count(search: SearchResult["search"], interval: "day" | "month", slice: Slice = { rows: [] }): Promise<Counted> {
  try {
    const reply = await post<CountsReply | { status: string; message?: string; error?: string }>("/scenes/counts", {
      search,
      interval,
      ...slice,
    })
    if (reply.status === "ok") return { status: "ok", tally: tallyFromCounts(reply as CountsReply) }
    const said = reply as { status: string; message?: string; error?: string }
    return said.status === "too_broad"
      ? { status: "too_broad", message: said.message ?? "Too many scenes to count. Narrow the search." }
      : { status: "failed", message: said.error ?? "The STAC API could not count the scenes." }
  } catch (e) {
    return { status: "failed", message: (e as Error).message }
  }
}

type Page = { status: string; scenes?: Scene[]; next?: string | null; error?: string }

async function page(search: SearchResult["search"], body: Record<string, unknown>): Promise<{ scenes: Scene[]; next: string | null }> {
  const reply = await post<Page>("/scenes/page", { search, ...body })
  if (reply.status !== "ok") throw new Error(reply.error ?? "The STAC API could not list the scenes.")
  return { scenes: reply.scenes ?? [], next: reply.next ?? null }
}

// Scenes join `known` once; a scene filed under two products can come back
// twice, and the first copy stays.
function remember(scenes: Scene[]) {
  useWhole.setState((s) => {
    const known = new Map(s.known)
    for (const sc of scenes) if (!known.has(sc.id)) known.set(sc.id, sc)
    return { known }
  })
}

function fresh(list: Scene[], more: Scene[]): Scene[] {
  const seen = new Set(list.map((s) => s.id))
  return [...list, ...more.filter((s) => !seen.has(s.id) && (seen.add(s.id), true))]
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function sliceOf(range: [number, number] | null, rows: Slice["rows"]): Slice {
  if (!range) return { rows }
  const start = Math.floor(range[0] / DAY_MS) * DAY_MS
  const end = Math.floor(range[1] / DAY_MS) * DAY_MS
  return { start: `${isoDay(start)}T00:00:00Z`, end: `${isoDay(end)}T23:59:59Z`, rows }
}

function intervalOf(result: SearchResult): "day" | "month" {
  const first = parseSceneDate(result.oldest)
  const last = parseSceneDate(result.newest)
  if (first === null || last === null) return "month"
  return (last - first) / DAY_MS <= DAY_STEP_MAX_DAYS ? "day" : "month"
}

// The rows to ask for: from the counts once they are in. Before then, or
// when the STAC API could not count, chosen satellites only; a chosen
// sensor or product waits for the counts, which name its product values.
function rowsFor(base: Counted, chosen: string[]): Slice["rows"] | null {
  if (base.status === "ok") return rowsOf(base.tally, chosen)
  const top = topChosen(chosen)
  if (base.status === "counting" && top.some((k) => k.includes(SEP))) return null
  return [...new Set(top.map((k) => k.split(SEP)[0]!))].map((satellite) => ({ satellite }))
}

export function loadMoreStrip() {
  const { result, strip } = useWhole.getState()
  if (!result?.search || !strip || !strip.next || strip.loading) return
  const { key, next } = strip
  useWhole.setState({ strip: { ...strip, loading: true } })
  page(result.search, { ...JSON.parse(key), limit: STRIP_PAGE, token: next })
    .then(({ scenes, next }) => {
      const now = useWhole.getState().strip
      if (useWhole.getState().result !== result || now?.key !== key) return
      remember(scenes)
      useWhole.setState({ strip: { ...now, scenes: fresh(now.scenes, scenes), next, loading: false } })
    })
    .catch((e: Error) => {
      const now = useWhole.getState().strip
      if (now?.key === key) useWhole.setState({ strip: { ...now, loading: false, error: e.message } })
    })
}

// Mounted once, with the map: loads what the current result, dates and rows
// need, whichever tab is open.
export function useWholeResult() {
  const result = useChatStore((s) => s.result)
  const scenes = useChatStore((s) => s.scenes)
  const timeRange = useChatStore((s) => s.timeRange)
  const chosen = useChatStore((s) => s.satelliteFilter)
  const chosenIds = useChatStore((s) => s.chosenIds)
  const base = useWhole((s) => s.base)

  useEffect(() => {
    if (!isPaged(result) || !result) {
      useWhole.setState(EMPTY)
      return
    }
    useWhole.setState({ ...EMPTY, result, known: new Map(scenes.map((s) => [s.id, s])) })
    let live = true
    void count(result.search, intervalOf(result)).then((counted) => {
      if (live) useWhole.setState({ base: counted })
    })
    return () => {
      live = false
    }
    // The scenes change together with the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  useEffect(() => {
    if (!isPaged(result) || !result?.search) return
    const search = result.search
    const timer = window.setTimeout(() => {
      const rows = rowsFor(base, chosen)
      if (!rows) return
      const slice = sliceOf(timeRange, rows)
      const key = JSON.stringify(slice)
      const now = useWhole.getState()
      const ours = () => useWhole.getState().result === result

      // Counts within the window, for a result counted per month.
      if (base.status === "ok" && base.tally.step === "month" && timeRange) {
        const windowSlice = sliceOf(timeRange, [])
        const windowKey = JSON.stringify(windowSlice)
        if (now.narrow?.key !== windowKey) {
          const days = (timeRange[1] - timeRange[0]) / DAY_MS
          useWhole.setState({ narrow: { key: windowKey, counted: { status: "counting" } } })
          void count(search, days <= DAY_STEP_MAX_DAYS ? "day" : "month", windowSlice).then((counted) => {
            if (ours() && useWhole.getState().narrow?.key === windowKey) useWhole.setState({ narrow: { key: windowKey, counted } })
          })
        }
      }

      if (now.strip?.key !== key) {
        // The earlier pages stay on show, filtered, until this one comes.
        useWhole.setState({ strip: { key, scenes: now.strip?.scenes ?? [], next: null, loading: true, error: null } })
        page(search, { ...slice, limit: STRIP_PAGE })
          .then(({ scenes, next }) => {
            if (!ours() || useWhole.getState().strip?.key !== key) return
            remember(scenes)
            useWhole.setState({ strip: { key, scenes, next, loading: false, error: null } })
          })
          .catch((e: Error) => {
            if (ours() && useWhole.getState().strip?.key === key)
              useWhole.setState({ strip: { key, scenes: [], next: null, loading: false, error: e.message } })
          })
      }
    }, SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [result, base, timeRange, chosen])

  // Chosen scenes a reopened conversation names but no page has brought.
  useEffect(() => {
    if (!isPaged(result) || !result?.search) return
    const known = useWhole.getState().known
    const missing = chosenIds.filter((id) => !known.has(id))
    if (!missing.length) return
    void page(result.search, { rows: [], ids: missing, limit: missing.length })
      .then(({ scenes }) => useWhole.getState().result === result && remember(scenes))
      .catch(() => undefined)
  }, [result, chosenIds])
}

// The tally of the dates on show: the whole result's with no window, cut to
// the window for a result counted per day, or the window's own counts for a
// result counted per month (the whole result's cut to it until they come).
export function windowTally(base: Tally | null, narrow: Whole["narrow"], range: [number, number] | null): Tally | null {
  if (!base || !range) return base
  const days: [number, number] = [Math.floor(range[0] / DAY_MS) * DAY_MS, Math.floor(range[1] / DAY_MS) * DAY_MS]
  if (base.step === "month" && narrow?.key === JSON.stringify(sliceOf(range, [])) && narrow.counted.status === "ok")
    return narrow.counted.tally
  return sliceTally(base, days)
}

// How many scenes the Scenes tab counts. `whole` is every scene of the
// result; `scope` every scene of the row opened (the whole result at the
// top) within the chosen dates; `inView` the scenes of the chosen rows among
// them. A result that holds only its newest scenes is counted by the STAC
// API: `counting` while that runs, and no numbers when it could not count;
// `counted` once the numbers are the STAC API's.
export type ResultCount = {
  counting: boolean
  counted: boolean
  opened: string | null
  windowed: boolean
  whole?: number
  scope?: number
  inView?: number
}

export function useResultCount(range: [number, number] | null, chosen: string[]): ResultCount {
  const result = useChatStore((s) => s.result)
  const scenes = useChatStore((s) => s.scenes)
  const opened = useOpened(result, chosen)
  const base = useWhole((s) => s.base)
  const narrow = useWhole((s) => s.narrow)
  const paged = isPaged(result)
  return useMemo(() => {
    const windowed = range !== null
    if (!paged)
      return {
        counting: false,
        counted: false,
        opened,
        windowed,
        whole: scenes.length,
        scope: visibleScenes(scenes, range, opened ? [opened] : []).length,
        inView: visibleScenes(scenes, range, chosen).length,
      }
    if (base.status !== "ok") return { counting: base.status === "counting", counted: false, opened, windowed }
    const win = windowTally(base.tally, narrow, range)
    return {
      counting: false,
      counted: true,
      opened,
      windowed,
      whole: base.tally.total,
      scope: opened ? chosenTotal(win ?? base.tally, [opened]) : windowed && win ? chosenTotal(win, []) : base.tally.total,
      inView: win ? chosenTotal(win, chosen) : undefined,
    }
  }, [paged, scenes, base, narrow, range, chosen, opened])
}

// The count under the rows and in the palette's bar, against the row opened
// within the chosen dates: "3,573 scenes" when everything in it shows, else
// "812 of 3,573 scenes". `returned` and `more` describe a result's own
// scenes, for a result the STAC API could not count or one saved before it
// counted.
export function countLine(c: ResultCount, returned: number, more: boolean): string {
  if (c.counting) return "Counting scenes…"
  if (c.scope === undefined) return sceneCount(returned, true)
  const of = sceneCount(c.scope, more && !c.counted && !c.opened && !c.windowed)
  return c.inView === undefined || c.inView === c.scope ? of : `${c.inView.toLocaleString("en")} of ${of}`
}

// The scenes the strip and the map draw from, before the dates and rows
// filter them: for a result that holds only its newest scenes, the latest
// pages once they come (the earlier pages until then); otherwise, and before
// any page, the result's own scenes.
export function useSceneSource(): Scene[] {
  const scenes = useChatStore((s) => s.scenes)
  const paged = useWhole((s) => s.strip?.scenes)
  return paged && paged.length ? paged : scenes
}

// Whether the strip holds the scenes of the current dates and rows: always
// for a result that holds every scene it matched, else once their first page
// has come.
export function useStripSettled(): boolean {
  const result = useChatStore((s) => s.result)
  const timeRange = useChatStore((s) => s.timeRange)
  const chosen = useChatStore((s) => s.satelliteFilter)
  const base = useWhole((s) => s.base)
  const strip = useWhole((s) => s.strip)
  if (!isPaged(result)) return true
  const rows = rowsFor(base, chosen)
  return !!rows && !!strip && !strip.loading && strip.key === JSON.stringify(sliceOf(timeRange, rows))
}

// One scene by id, from the result's own scenes or any page fetched.
export function useScene(id: string | null): Scene | undefined {
  const scenes = useChatStore((s) => s.scenes)
  const known = useWhole((s) => s.known)
  return useMemo(() => (id ? (scenes.find((s) => s.id === id) ?? known.get(id)) : undefined), [scenes, known, id])
}

// The chosen scenes, from the result's own scenes and every page fetched.
// The same list while the choice and its scenes stay the same, however many
// pages come in.
export function useChosenScenes(): Scene[] {
  const scenes = useChatStore((s) => s.scenes)
  const chosenIds = useChatStore((s) => s.chosenIds)
  const byId = useMemo(() => new Map(scenes.map((s) => [s.id, s])), [scenes])
  return useWhole(
    useShallow((s) =>
      chosenIds.flatMap((id) => {
        const scene = byId.get(id) ?? s.known.get(id)
        return scene ? [scene] : []
      }),
    ),
  )
}
