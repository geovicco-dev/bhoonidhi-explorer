"use client"

import { useEffect, type ReactNode } from "react"
import { IconCheck, IconX } from "@tabler/icons-react"
import { aoiSize } from "@/features/aoi/geo"
import { useAoiStore } from "@/features/aoi/store"
import { armTool } from "@/features/aoi/useAoiShortcuts"
import { useChatStore } from "@/features/chat/store"
import { usePaletteStore } from "@/features/palette/store"
import { PLACE_PREFIX } from "@/features/aoi/places"
import { setAreaFromForm } from "./open"
import { itemName, useQueryStore, type ArchiveSatellite, type QueryItem, type QueryProblem } from "./store"

// The query form: products, area, dates, availability and resolution, laid
// out like STAC Browser's search. The palette's input filters the product
// list. Every edit is checked; nothing is searched until the query is run
// (Enter or Run query), and the result then comes back as a turn.

const AVAILABILITY = [
  { value: null, label: "Any" },
  { value: "Ready", label: "Ready" },
  { value: "Archived", label: "Archived" },
  { value: "OnOrder", label: "On order" },
  { value: "Priced", label: "Priced" },
] as const

const ACCESS: Record<string, { label: string; className: string }> = {
  DirectDownload: { label: "free", className: "border-success/60 text-success" },
  OnOrder: { label: "free · on order", className: "border-[var(--bx-amber-500)]/60 text-[var(--bx-amber-500)]" },
  Priced: { label: "priced", className: "border-danger/60 text-danger" },
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "")

// "05/08/2011" (the portal's month/day/year) as "2011-05-08"; empty means now.
function isoDate(mdY: string | null): string {
  if (!mdY) return "now"
  const [m, d, y] = mdY.split("/")
  return y && m && d ? `${y}-${m}-${d}` : mdY
}

// On a phone held upright the label sits above its field, so the field gets
// the form's full width; from 480px up the labels form a column on the left.
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-1.5 min-[480px]:flex-row min-[480px]:items-start min-[480px]:gap-3">
      <span className="text-xs text-fg-faint min-[480px]:w-20 min-[480px]:shrink-0 min-[480px]:pt-1">
        {label}
      </span>
      <div className="flex min-w-0 flex-col gap-1 min-[480px]:flex-1">
        {children}
      </div>
    </div>
  )
}

function Problems({ problems, field }: { problems: QueryProblem[]; field: string }) {
  const applyFix = useQueryStore((s) => s.applyFix)
  const mine = problems.filter((p) => p.field === field)
  if (!mine.length) return null
  return (
    <>
      {mine.map((p, i) => (
        <p key={i} className="text-[11.5px] text-danger">
          {p.text}
          {p.fix && (
            <button
              type="button"
              onClick={() => applyFix(p.fix!)}
              className="ml-1.5 rounded border border-border-default px-1.5 text-[11px] text-fg hover:border-action"
            >
              {p.fix.label}
            </button>
          )}
        </p>
      ))}
    </>
  )
}

const sameItem = (a: QueryItem, b: QueryItem) =>
  a.satellite === b.satellite && (a.sensor ?? null) === (b.sensor ?? null) && (a.product ?? null) === (b.product ?? null)

function ProductList({ satellites, filter }: { satellites: ArchiveSatellite[]; filter: string }) {
  const items = useQueryStore((s) => s.query.items)
  const toggleItem = useQueryStore((s) => s.toggleItem)
  const f = norm(filter)
  const rows: ReactNode[] = []
  for (const sat of satellites) {
    const products = sat.products.filter(
      (p) => !f || norm(`${sat.satellite}${p.sensor}${p.product ?? ""}${p.description}`).includes(f),
    )
    if (!products.length) continue
    const satItem: QueryItem = { satellite: sat.satellite }
    const satOn = items.some((i) => sameItem(i, satItem))
    const access = ACCESS[sat.access]
    rows.push(
      <button
        key={sat.satellite}
        type="button"
        onClick={() => toggleItem(satItem)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] font-medium text-fg hover:bg-surface-inset"
      >
        <Box on={satOn} />
        <span className="min-w-0 flex-1 truncate">
          {sat.satellite}
          <span className="ml-2 text-[11px] font-normal text-fg-faint">
            {sat.from} → {sat.to}
          </span>
        </span>
        {access && <span className={`shrink-0 rounded-full border px-1.5 text-[10px] ${access.className}`}>{access.label}</span>}
      </button>,
    )
    for (const p of products) {
      const item: QueryItem = p.product
        ? { satellite: sat.satellite, sensor: p.sensor, product: p.product, selection: p.selection }
        : { satellite: sat.satellite, sensor: p.sensor }
      const on = satOn || items.some((i) => sameItem(i, item))
      rows.push(
        <button
          key={p.selection}
          type="button"
          onClick={() => toggleItem(item)}
          title={p.has_scenes ? p.description : "No scenes in the STAC API yet"}
          className={[
            "flex w-full items-center gap-2 rounded-md py-0.5 pr-2 pl-7 text-left text-[12px] text-fg-muted hover:bg-surface-inset hover:text-fg",
            p.has_scenes ? "" : "opacity-45",
          ].join(" ")}
        >
          <Box on={on} />
          <span className="min-w-0 flex-1 truncate">
            {p.sensor}
            {p.product && <span className="text-fg-faint"> · {p.product}</span>}
            {!p.has_scenes && <span className="ml-1.5 text-[11px] text-fg-faint">no scenes yet</span>}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-fg-faint">
            {p.resolution_m} m · {isoDate(p.start).slice(0, 4)}–{isoDate(p.end).slice(0, 4)}
          </span>
        </button>,
      )
    }
  }
  if (!rows.length) return <p className="px-2 py-3 text-center text-xs text-fg-faint">Nothing matches “{filter}”.</p>
  return <>{rows}</>
}

function Box({ on }: { on: boolean }) {
  return (
    <span
      className={[
        "flex size-3.5 shrink-0 items-center justify-center rounded border",
        on ? "border-action bg-action text-on-action" : "border-border-default",
      ].join(" ")}
    >
      {on && <IconCheck size={10} stroke={3} />}
    </span>
  )
}

function windowCount(from: string, to: string, yearly: boolean): number | null {
  if (!yearly || from.length !== 10 || to.length !== 10) return null
  const crosses = to.slice(5) < from.slice(5)
  return Math.max(0, Number(to.slice(0, 4)) - Number(from.slice(0, 4)) + (crosses ? 0 : 1))
}

export function QueryForm({ filter }: { filter: string }) {
  const query = useQueryStore((s) => s.query)
  const set = useQueryStore((s) => s.set)
  const problems = useQueryStore((s) => s.problems)
  const notes = useQueryStore((s) => s.notes)
  const checking = useQueryStore((s) => s.checking)
  const error = useQueryStore((s) => s.error)
  const products = useQueryStore((s) => s.products)
  const productsError = useQueryStore((s) => s.productsError)
  const toggleItem = useQueryStore((s) => s.toggleItem)
  const aoi = useAoiStore((s) => s.aoi)
  const running = useQueryStore((s) => s.running)
  // A query cannot run while the agent is answering. It can while the
  // question only waits in line: running takes the question's place.
  const agentBusy = useChatStore((s) => s.streaming && !s.waiting)
  const waitingForModel = useChatStore((s) => !!s.waiting)
  const setView = usePaletteStore((s) => s.setView)

  // The query's area is the area on the map.
  useEffect(() => {
    if (aoi !== useQueryStore.getState().query.area) set({ area: aoi })
  }, [aoi, set])

  const windows = windowCount(query.dates.from, query.dates.to, query.dates.yearly)
  const blocked = problems.length > 0
  const button = "rounded-md border border-border-default px-2 py-0.5 text-[11.5px] text-fg-muted hover:border-action hover:text-fg"

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        <Row label="Satellites">
          {query.items.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {query.items.map((item, i) => (
                <span
                  key={`${itemName(item)}-${i}`}
                  className={[
                    "flex items-center gap-1 rounded-md border bg-surface-inset py-px pr-0.5 pl-2 text-[12px]",
                    problems.some((p) => p.item === i) ? "border-danger text-danger" : "border-transparent text-fg",
                  ].join(" ")}
                >
                  {itemName(item)}
                  <button
                    type="button"
                    aria-label={`Remove ${itemName(item)}`}
                    onClick={() => toggleItem(item)}
                    className="flex size-4 items-center justify-center rounded text-fg-faint hover:bg-surface hover:text-fg"
                  >
                    <IconX size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="max-h-40 overflow-y-auto rounded-lg border border-border-default p-1">
            {productsError ? (
              <p className="px-2 py-3 text-xs text-danger">Could not load the product list: {productsError}</p>
            ) : products ? (
              <ProductList satellites={products} filter={filter} />
            ) : (
              <p className="px-2 py-3 text-center text-xs text-fg-faint">Loading the product list…</p>
            )}
          </div>
          <p className="text-[11px] text-fg-faint">
            Type above to filter.{" "}
            <button type="button" className="text-action hover:underline" onClick={() => setView("archive")}>
              Browse the archive
            </button>
          </p>
          <Problems problems={problems} field="items" />
        </Row>

        <Row label="Dates">
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              type="date"
              aria-label="From"
              value={query.dates.from}
              onChange={(e) => set({ dates: { ...query.dates, from: e.target.value } })}
              className="rounded-md border border-border-default bg-surface-inset px-1.5 py-0.5 text-[12px] text-fg outline-none focus:border-action"
            />
            <span className="text-xs text-fg-faint">to</span>
            <input
              type="date"
              aria-label="To"
              value={query.dates.to}
              onChange={(e) => set({ dates: { ...query.dates, to: e.target.value } })}
              className="rounded-md border border-border-default bg-surface-inset px-1.5 py-0.5 text-[12px] text-fg outline-none focus:border-action"
            />
          </div>
          <label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
            <input
              type="checkbox"
              checked={query.dates.yearly}
              onChange={(e) => set({ dates: { ...query.dates, yearly: e.target.checked } })}
            />
            Repeat each year
            {windows !== null && (
              <span className="text-fg-faint">
                · the same days in each of {windows} {windows === 1 ? "year" : "years"}
              </span>
            )}
          </label>
          <Problems problems={problems} field="dates" />
        </Row>

        <Row label="Area">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-md bg-surface-inset px-2 py-0.5 text-[12px] text-fg">
              {aoi ? `${aoi.name ?? (aoi.kind === "circle" ? "Circle" : "Box")} · ${aoiSize(aoi)}` : "Anywhere"}
            </span>
            <button
              type="button"
              className={button}
              onClick={() => {
                setAreaFromForm()
                setView("main")
                usePaletteStore.getState().setQuery(PLACE_PREFIX)
              }}
            >
              Place @
            </button>
            <button
              type="button"
              className={button}
              onClick={() => {
                setAreaFromForm()
                armTool("rectangle")
              }}
            >
              Draw R
            </button>
            <button
              type="button"
              className={button}
              onClick={() => {
                setAreaFromForm()
                armTool("point")
              }}
            >
              Point P
            </button>
          </div>
          <label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
            <input type="checkbox" checked={query.covers_area} onChange={(e) => set({ covers_area: e.target.checked })} />
            Only scenes that cover all of it
          </label>
          <Problems problems={problems} field="area" />
        </Row>

        <Row label="Availability">
          <div className="flex w-fit overflow-hidden rounded-md border border-border-default">
            {AVAILABILITY.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={() => set({ availability: a.value })}
                className={[
                  "px-2 py-0.5 text-[11.5px]",
                  query.availability === a.value ? "bg-surface-inset text-fg" : "text-fg-muted hover:text-fg",
                ].join(" ")}
              >
                {a.label}
              </button>
            ))}
          </div>
          <Problems problems={problems} field="availability" />
        </Row>

        <Row label="Resolution">
          <div className="flex items-center gap-1.5 text-[12px] text-fg-muted">
            finer than
            <input
              type="number"
              min={0}
              step="any"
              aria-label="Finer than, in metres"
              value={query.max_resolution_m ?? ""}
              onChange={(e) => set({ max_resolution_m: e.target.value === "" ? null : Number(e.target.value) })}
              className="w-16 rounded-md border border-border-default bg-surface-inset px-1.5 py-0.5 text-[12px] text-fg outline-none focus:border-action"
            />
            m
          </div>
          <Problems problems={problems} field="resolution" />
        </Row>

        {notes.length > 0 && !blocked && (
          <div className="px-3 pt-1">
            {notes.map((n) => (
              <p key={n} className="text-[11.5px] text-fg-faint">
                {n}
              </p>
            ))}
          </div>
        )}
        {error && <p className="px-3 pt-1 text-[11.5px] text-danger">{error}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border-default px-3 py-1.5 text-[12px] text-fg-muted">
        <span
          className={[
            "size-1.5 shrink-0 rounded-full",
            blocked || error ? "bg-danger" : checking || running || agentBusy ? "bg-fg-faint" : "bg-success",
          ].join(" ")}
        />
        <span className="min-w-0 flex-1 truncate" aria-live="polite">
          {blocked
            ? `Not run: ${problems.length} ${problems.length === 1 ? "problem" : "problems"} to fix`
            : checking
              ? "Checking…"
              : error
                ? "Not run: the query could not be checked"
                : running
                  ? "Searching the STAC API…"
                  : agentBusy
                    ? "Waiting for the agent's answer to finish"
                    : waitingForModel
                      ? "Ready: running this replaces the waiting question"
                      : "Ready to run"}
        </span>
        <RunButton disabled={blocked || checking || !!error || running || agentBusy} />
      </div>
    </div>
  )
}

function RunButton({ disabled }: { disabled: boolean }) {
  const run = useRunQuery()
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void run()}
      className="shrink-0 rounded-md bg-action px-2 py-0.5 text-[12px] font-medium text-on-action disabled:opacity-40"
    >
      Run query ↵
    </button>
  )
}

// Runs the form's query as a turn and shows the conversation. A second Enter
// while the first run is saving does nothing, so a query is never saved twice.
// A question still waiting for the model is taken out of the line first: the
// query answers it instead, without the model.
export function useRunQuery() {
  const runQuery = useChatStore((s) => s.runQuery)
  const withdraw = useChatStore((s) => s.withdraw)
  const setView = usePaletteStore((s) => s.setView)
  return async () => {
    const { query, editingTurn, problems, checking, error, running } = useQueryStore.getState()
    // Only a query the API has checked and found no problem with runs.
    if (problems.length || checking || error || running) return
    useQueryStore.setState({ running: true })
    await withdraw()
    const ran = await runQuery(query, editingTurn)
    useQueryStore.setState(ran ? { running: false, editingTurn: null } : { running: false })
    if (ran) setView("main")
  }
}
