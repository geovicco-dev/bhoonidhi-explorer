import { create } from "zustand"
import { env } from "@/lib/env"
import { failure } from "@/lib/http"
import type { Aoi } from "@/features/aoi/types"

// Query mode: a catalogue search built in a form (products, area, dates,
// availability, resolution) and run without the agent. Every edit is checked
// by the API; the catalogue is searched only when the query is run, and a
// query with any problem never is.

// One pick in the product list: a whole satellite, one sensor on it, or one
// product of that sensor. Names are `bhd`'s.
export type QueryItem = {
  satellite: string
  sensor?: string | null
  product?: string | null
  selection?: string | null
}

export type QueryDates = { from: string; to: string; yearly: boolean }

export type Query = {
  items: QueryItem[]
  area: Aoi | null
  covers_area: boolean
  dates: QueryDates
  availability: string | null
  max_resolution_m: number | null
}

// A fix the API offers with a problem: remove an item, change a product, or
// set fields.
export type QueryFix = {
  label: string
  remove_item?: number
  set_item?: { index: number; product: string | null }
  set?: Partial<Query>
}

export type QueryProblem = { field: string; text: string; item?: number; fix?: QueryFix }

type QueryCheck = { ok: boolean; problems: QueryProblem[]; notes: string[] }

export type ArchiveProduct = {
  selection: string
  sensor: string
  product: string | null
  description: string
  resolution_m: string | null
  start: string | null
  end: string | null
  collection: string | null
  catalogue_start: string | null
  catalogue_end: string | null
  has_scenes: boolean
}

export type ArchiveSatellite = {
  satellite: string
  access: "DirectDownload" | "OnOrder" | "Priced" | string
  from: string | null
  to: string | null
  products: ArchiveProduct[]
}

// The last full month before today: a first query that shows something.
function lastMonth(): QueryDates {
  const now = new Date()
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { from: iso(first), to: iso(last), yearly: false }
}

export function blankQuery(area: Aoi | null): Query {
  return { items: [], area, covers_area: false, dates: lastMonth(), availability: null, max_resolution_m: null }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.agentApiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await failure(res, path)
  return (await res.json()) as T
}

export const queryApi = {
  products: async (): Promise<ArchiveSatellite[]> => {
    const res = await fetch(`${env.agentApiUrl}/query/products`)
    if (!res.ok) throw new Error(`/query/products -> ${res.status}`)
    return ((await res.json()) as { satellites: ArchiveSatellite[] }).satellites
  },
  check: (query: Query) => post<QueryCheck>("/query/check", { query }),
  bhd: (query: Query, sceneIds: string[]) =>
    post<{ steps?: { what: string; command: string }[]; note?: string; error?: string }>("/query/bhd", {
      query,
      scene_ids: sceneIds,
    }),
  fromSearch: (args: Record<string, unknown>) => post<{ query: Query }>("/query/from-search", { arguments: args }),
  fromQuestion: (body: { text: string; area: Aoi | null; base: Query; search_args: Record<string, unknown> | null }) =>
    post<{ query: Query }>("/query/from-question", body),
}

type QueryState = {
  query: Query
  // The turn an "Edit query" replaces, or null for a new turn.
  editingTurn: number | null
  // The API's check of the current query. Nothing is searched until Run.
  checking: boolean
  problems: QueryProblem[]
  notes: string[]
  error: string | null
  // True while a run is searching and saving its turn.
  running: boolean
  // bhd's product list, loaded once.
  products: ArchiveSatellite[] | null
  productsError: string | null

  open: (query?: Query | null, turn?: number | null) => void
  set: (patch: Partial<Query>) => void
  applyFix: (fix: QueryFix) => void
  toggleItem: (item: QueryItem) => void
  loadProducts: () => Promise<void>
}

let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null

export const useQueryStore = create<QueryState>((set, get) => {
  // Every edit is checked again, a little after typing stops. Answers from
  // an older edit are dropped.
  const recheck = () => {
    if (timer) clearTimeout(timer)
    set({ checking: true })
    timer = setTimeout(async () => {
      const mine = ++seq
      try {
        const result = await queryApi.check(get().query)
        if (mine !== seq) return
        // A reply without the lists (an old or broken API) leaves the form
        // usable instead of taking the palette down with it.
        set({ checking: false, error: null, problems: result.problems ?? [], notes: result.notes ?? [] })
      } catch (err) {
        if (mine !== seq) return
        set({ checking: false, error: (err as Error).message })
      }
    }, 250)
  }

  return {
    query: blankQuery(null),
    editingTurn: null,
    checking: false,
    problems: [],
    notes: [],
    error: null,
    running: false,
    products: null,
    productsError: null,

    open: (query, turn = null) => {
      set({ query: query ?? get().query, editingTurn: turn, problems: [], error: null })
      void get().loadProducts()
      recheck()
    },

    set: (patch) => {
      set((s) => ({ query: { ...s.query, ...patch } }))
      recheck()
    },

    applyFix: (fix) => {
      const q = get().query
      let items = q.items
      if (fix.remove_item !== undefined) items = items.filter((_, i) => i !== fix.remove_item)
      if (fix.set_item) {
        const { index, product } = fix.set_item
        items = items.map((it, i) => (i === index ? { ...it, product, selection: null } : it))
      }
      get().set({ ...fix.set, items })
    },

    toggleItem: (item) => {
      const same = (a: QueryItem) =>
        a.satellite === item.satellite && (a.sensor ?? null) === (item.sensor ?? null) && (a.product ?? null) === (item.product ?? null)
      const items = get().query.items
      get().set({ items: items.some(same) ? items.filter((a) => !same(a)) : [...items, item] })
    },

    loadProducts: async () => {
      if (get().products) return
      try {
        set({ products: await queryApi.products(), productsError: null })
      } catch (err) {
        set({ productsError: (err as Error).message })
      }
    },
  }
})

export function itemName(item: QueryItem): string {
  return [item.satellite, item.sensor, item.product].filter(Boolean).join(" ")
}
