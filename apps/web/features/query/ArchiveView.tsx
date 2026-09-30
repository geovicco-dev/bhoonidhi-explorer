"use client"

import { Fragment, useEffect, useMemo, useState } from "react"
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react"
import { useAoiStore } from "@/features/aoi/store"
import { usePaletteStore } from "@/features/palette/store"
import { blankQuery, useQueryStore, type ArchiveProduct, type ArchiveSatellite } from "./store"

// The archive browser: every satellite and sensor `bhd` knows, when each ran,
// its resolution and access. A product's "Query" opens the query form for it.

type Sensor = {
  key: string
  satellite: string
  sensor: string
  access: string
  res: number | null
  start: string | null
  // null: still operating.
  end: string | null
  catalogueEnd: string | null
  collection: string | null
  products: ArchiveProduct[]
}

// Hand-written: the catalogue records no operator (its AGENCY field holds
// ground-station codes).
function operator(sat: string): string {
  if (/^(IRS|ResourceSat|CartoSat|OceanSat|EOS|RISAT)/i.test(sat)) return "ISRO"
  if (sat === "NISAR") return "NASA and ISRO"
  if (/^Sentinel/i.test(sat)) return "ESA (Copernicus)"
  if (/^LandSat/i.test(sat)) return "USGS and NASA"
  if (/^(Terra|Aqua)$/i.test(sat)) return "NASA"
  if (/^(NOAA|JPSS|Suomi)/i.test(sat)) return "NOAA and NASA"
  if (/^MetOp/i.test(sat)) return "EUMETSAT"
  if (/^KompSat/i.test(sat)) return "KARI (Korea)"
  if (/^Novasar/i.test(sat)) return "SSTL (UK)"
  return "Other"
}

const KINDS = ["Optical, under 2 m", "Optical, 2 to 10 m", "Optical, 10 to 80 m", "Optical, coarser than 80 m", "Radar", "Other"]

function kind(s: Sensor): string {
  if (/SAR/i.test(s.sensor)) return "Radar"
  if (s.res === null) return "Other"
  if (s.res < 2) return KINDS[0]!
  if (s.res <= 10) return KINDS[1]!
  if (s.res <= 80) return KINDS[2]!
  return KINDS[3]!
}

// "05/08/2011" (month/day/year) as "2011-05-08".
function iso(mdY: string | null): string | null {
  if (!mdY) return null
  const [m, d, y] = mdY.split("/")
  return y && m && d ? `${y}-${m}-${d}` : null
}

function sensorsOf(satellites: ArchiveSatellite[]): Sensor[] {
  const out: Sensor[] = []
  for (const sat of satellites) {
    const bySensor = new Map<string, ArchiveProduct[]>()
    for (const p of sat.products) bySensor.set(p.sensor, [...(bySensor.get(p.sensor) ?? []), p])
    for (const [sensor, products] of bySensor) {
      const res = products.map((p) => parseFloat(p.resolution_m ?? "")).filter((v) => !Number.isNaN(v))
      const starts = products.map((p) => iso(p.start)).filter((v): v is string => !!v).sort()
      const ongoing = products.some((p) => !p.end)
      const ends = products.map((p) => iso(p.end)).filter((v): v is string => !!v).sort()
      out.push({
        key: `${sat.satellite}|${sensor}`,
        satellite: sat.satellite,
        sensor,
        access: sat.access,
        res: res.length ? Math.min(...res) : null,
        start: starts[0] ?? null,
        end: ongoing ? null : (ends.at(-1) ?? null),
        catalogueEnd: products.find((p) => p.catalogue_end)?.catalogue_end ?? null,
        collection: products.find((p) => p.collection)?.collection ?? null,
        products,
      })
    }
  }
  return out
}

const Y0 = 1988
const Y1 = new Date().getUTCFullYear() + 1
const x = (d: string | null) => {
  const t = d ? Number(d.slice(0, 4)) + (Number(d.slice(5, 7)) - 1) / 12 : Y1
  return Math.max(0, Math.min(100, ((t - Y0) / (Y1 - Y0)) * 100))
}

function lastDay(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function ArchiveView({ filter }: { filter: string }) {
  const products = useQueryStore((s) => s.products)
  const productsError = useQueryStore((s) => s.productsError)
  const loadProducts = useQueryStore((s) => s.loadProducts)
  const openQuery = useQueryStore((s) => s.open)
  const setView = usePaletteStore((s) => s.setView)
  const aoi = useAoiStore((s) => s.aoi)
  const [now, setNow] = useState(false)
  const [free, setFree] = useState(false)
  const [fine, setFine] = useState(false)
  const [group, setGroup] = useState<"kind" | "operator" | "az">("kind")
  const [open, setOpen] = useState<Set<string>>(new Set())

  useEffect(() => {
    void loadProducts()
  }, [loadProducts])


  const sensors = useMemo(() => (products ? sensorsOf(products) : []), [products])
  const f = filter.toLowerCase().replace(/[^a-z0-9]/g, "")
  const shown = sensors.filter((s) => {
    const text = `${s.satellite}${s.sensor}${s.products.map((p) => `${p.product ?? ""}${p.description}`).join("")}${operator(s.satellite)}${kind(s)}`
    return (
      (!f || text.toLowerCase().replace(/[^a-z0-9]/g, "").includes(f)) &&
      (!now || !s.end) &&
      (!free || s.access !== "Priced") &&
      (!fine || (s.res !== null && s.res <= 10))
    )
  })
  const groupOf = (s: Sensor) => (group === "kind" ? kind(s) : group === "operator" ? operator(s.satellite) : "All sensors, A to Z")
  const groups = new Map<string, Sensor[]>()
  for (const s of shown) groups.set(groupOf(s), [...(groups.get(groupOf(s)) ?? []), s])
  const order = [...groups.keys()].sort((a, b) => (group === "kind" ? KINDS.indexOf(a) - KINDS.indexOf(b) : a.localeCompare(b)))

  const query = (s: Sensor, p: ArchiveProduct | null) => {
    const last = s.catalogueEnd ?? new Date().toISOString().slice(0, 10)
    const y = Number(last.slice(0, 4))
    const m = Number(last.slice(5, 7))
    const mm = String(m).padStart(2, "0")
    openQuery({
      ...blankQuery(aoi),
      items: [p?.product ? { satellite: s.satellite, sensor: s.sensor, product: p.product, selection: p.selection } : { satellite: s.satellite, sensor: s.sensor }],
      dates: { from: `${y}-${mm}-01`, to: `${y}-${mm}-${lastDay(y, m)}`, yearly: false },
    })
    setView("query")
  }

  const toggle = "rounded-full border px-2 text-[11px]"
  const on = "border-action bg-action/10 text-fg"
  const off = "border-border-default text-fg-muted hover:text-fg"

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border-default px-3 py-1.5">
        <button type="button" onClick={() => setNow(!now)} className={`${toggle} ${now ? on : off}`}>
          Operating now
        </button>
        <button type="button" onClick={() => setFree(!free)} className={`${toggle} ${free ? on : off}`}>
          Free
        </button>
        <button type="button" onClick={() => setFine(!fine)} className={`${toggle} ${fine ? on : off}`}>
          10 m or finer
        </button>
        <span className="ml-auto flex items-center gap-1 text-[10.5px] text-fg-faint">
          Group
          <span className="flex overflow-hidden rounded-md border border-border-default">
            {(["kind", "operator", "az"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGroup(g)}
                className={`px-1.5 py-px ${group === g ? "bg-surface-inset text-fg" : "text-fg-muted"}`}
              >
                {g === "kind" ? "Kind" : g === "operator" ? "Operator" : "A–Z"}
              </button>
            ))}
          </span>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {productsError && <p className="px-2 py-4 text-xs text-danger">Could not load the archive: {productsError}</p>}
        {!products && !productsError && <p className="px-2 py-6 text-center text-xs text-fg-faint">Loading the archive…</p>}
        {products && (
          <p className="px-2 pt-1 pb-1 text-[11px] text-fg-faint">
            {shown.length} sensors on {new Set(shown.map((s) => s.satellite)).size} satellites
          </p>
        )}
        {products && (
          <div className="grid grid-cols-[14px_170px_1fr_58px] gap-2 px-2 font-mono text-[10px] text-fg-faint">
            <span />
            <span />
            <span className="relative h-3">
              {[1990, 2000, 2010, 2020].map((y) => (
                <span key={y} className="absolute -translate-x-1/2" style={{ left: `${((y - Y0) / (Y1 - Y0)) * 100}%` }}>
                  {y}
                </span>
              ))}
            </span>
            <span className="text-right">res.</span>
          </div>
        )}
        {order.map((g) => (
          <Fragment key={g}>
            <div className="flex justify-between px-2 pt-2 pb-0.5 text-[10.5px] font-medium tracking-wide text-fg-faint uppercase">
              <span>{g}</span>
              <span>{groups.get(g)!.length}</span>
            </div>
            {groups.get(g)!.map((s) => {
              const isOpen = open.has(s.key)
              return (
                <Fragment key={s.key}>
                  <button
                    type="button"
                    onClick={() => {
                      const next = new Set(open)
                      if (isOpen) next.delete(s.key)
                      else next.add(s.key)
                      setOpen(next)
                    }}
                    className="grid w-full grid-cols-[14px_170px_1fr_58px] items-center gap-2 rounded-md px-2 py-0.5 text-left hover:bg-surface-inset"
                  >
                    {isOpen ? <IconChevronDown size={12} className="text-fg-faint" /> : <IconChevronRight size={12} className="text-fg-faint" />}
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] text-fg">
                        {s.satellite} · {s.sensor}
                      </span>
                      <span className="block truncate text-[10.5px] text-fg-faint">
                        {s.start?.slice(0, 4) ?? "?"} to {s.end ? s.end.slice(0, 4) : "now"} ·{" "}
                        {s.access === "Priced" ? "priced" : s.access === "OnOrder" ? "free, on order" : "free"}
                      </span>
                    </span>
                    <span className="relative h-3.5">
                      <span
                        className={`absolute top-1 h-1.5 rounded-full ${s.end ? "bg-border-strong" : "bg-action/70"}`}
                        style={{ left: `${x(s.start)}%`, width: `${Math.max(0.8, x(s.end) - x(s.start))}%` }}
                      />
                    </span>
                    <span className="text-right font-mono text-[11px] text-fg-muted">
                      {s.res !== null ? `${s.res} m` : ""}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="mb-1 ml-8 border-l border-border-default pl-2.5">
                      {s.products.map((p) => (
                        <div key={p.selection} className={`flex items-center gap-2 py-0.5 text-[11.5px] ${p.has_scenes ? "text-fg-muted" : "text-fg-faint opacity-60"}`}>
                          <span className="min-w-0 flex-1 truncate">
                            {p.product ?? "Standard product"}
                            <span className="text-fg-faint">
                              {" "}
                              · {p.description}
                              {!p.has_scenes && " · no scenes in the STAC API yet"}
                            </span>
                          </span>
                          <span className="shrink-0 font-mono text-[10.5px] text-fg-faint">
                            {p.resolution_m} m · {iso(p.start) ?? "?"} → {iso(p.end) ?? "now"}
                          </span>
                          {p.has_scenes && (
                            <button
                              type="button"
                              onClick={() => query(s, p)}
                              className="shrink-0 rounded border border-border-default px-1.5 text-[11px] text-fg hover:border-action"
                            >
                              Query
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Fragment>
              )
            })}
          </Fragment>
        ))}
        {products && !shown.length && <p className="px-2 py-4 text-center text-xs text-fg-faint">No sensor matches.</p>}
      </div>
    </div>
  )
}
