"use client"

import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from "react"
import { IconChevronRight } from "@tabler/icons-react"

// The rows under the date overview: one row per satellite, sensor or product,
// one column per period, each cell as strong as its scene count. Drag across
// the columns to mark a stretch (the Scenes tab zooms to it on release).
// Click a row's name to open it (a satellite's sensors, a sensor's products;
// a product's name chooses it); click its coloured square to choose it along
// with others. Arrows move the marked stretch, Escape clears it. When the
// tab is short the rows scroll inside the chart.
//
// Drawn here rather than with the design system's DensityTimeline, which
// fixes each cell's strength at 28% to 100% on a straight scale: a satellite
// with far fewer scenes than the busiest one then stays near 28% and all but
// disappears on the dark grid. Here a cell with any scene starts at half
// strength and the scale rises steeply for small counts (square root), still
// shared by every row, so a stronger cell always means more scenes.

export type DisplayRow = {
  key: string
  label: string
  color: string
  // Scenes in the chosen dates.
  count: number
  // Opens into rows of its own (a satellite or a sensor).
  expandable: boolean
  chosen: boolean
  dimmed: boolean
}

type Props = {
  rows: DisplayRow[]
  buckets: string[]
  // counts[row][bucket]
  counts: number[][]
  // Marked columns [first, last], or null.
  range: [number, number] | null
  onRange: (range: [number, number] | null) => void
  onOpen: (key: string) => void
  onChoose: (key: string) => void
  // Strength of a cell with one scene when the busiest cell is far busier.
  floor: number
  // Shared with the overview above, so the graph sits exactly over the columns.
  labelWidth: string
}

const ROW_H = 18
// At least two rows stay in view (two rows, the 1 px between them and the
// grid's 1 px padding top and bottom); the rest scroll.
const SCROLL_MIN_H = 2 * ROW_H + 3
const AXIS_H = 14
// The least height the rows need, with the 8 px gap and the dates under
// them. The Scenes tab keeps at least this much for them, so on a window too
// short for it the tab scrolls instead of the rows running into what follows.
export const ROWS_MIN_H = SCROLL_MIN_H + 8 + AXIS_H

export function SatelliteRows({ rows, buckets, counts, range, onRange, onOpen, onChoose, floor, labelWidth }: Props) {
  const gridRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<number | null>(null)
  const n = buckets.length
  const peak = Math.max(1, ...counts.flat())
  const strength = (c: number) => (c === 0 ? 0 : floor + (1 - floor) * Math.sqrt(c / peak))

  const column = useCallback(
    (clientX: number) => {
      const r = gridRef.current?.getBoundingClientRect()
      if (!r || n === 0) return 0
      return Math.floor(Math.max(0, Math.min(0.9999, (clientX - r.left) / (r.width || 1))) * n)
    },
    [n],
  )

  const onPointerDown = (e: PointerEvent) => {
    gridRef.current?.setPointerCapture(e.pointerId)
    const b = column(e.clientX)
    dragStart.current = b
    onRange([b, b])
  }
  const onPointerMove = (e: PointerEvent) => {
    if (dragStart.current === null) return
    const b = column(e.clientX)
    onRange([Math.min(dragStart.current, b), Math.max(dragStart.current, b)])
  }
  const onPointerUp = (e: PointerEvent) => {
    dragStart.current = null
    if (gridRef.current?.hasPointerCapture(e.pointerId)) gridRef.current.releasePointerCapture(e.pointerId)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") return onRange(null)
    const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0
    if (!dir) return
    e.preventDefault()
    const [a, b] = range ?? [0, 0]
    const start = Math.max(0, Math.min(n - 1 - (b - a), a + dir))
    onRange([start, start + (b - a)])
  }

  const sel = range ?? [0, n - 1]
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex gap-2 overflow-y-auto overscroll-contain" style={{ minHeight: SCROLL_MIN_H }}>
        <div className="flex shrink-0 flex-col gap-px pt-px font-mono text-[10px]" style={{ width: labelWidth }}>
          {rows.map((row) => (
            <div
              key={row.key}
              className={["flex items-center gap-1 transition-opacity", row.dimmed ? "opacity-45" : ""].join(" ")}
              style={{ height: ROW_H }}
            >
              <button
                type="button"
                onClick={() => onChoose(row.key)}
                aria-pressed={row.chosen}
                aria-label={row.chosen ? `Stop choosing ${row.label}` : `Choose ${row.label}`}
                title={row.chosen ? `Stop choosing ${row.label}` : `Choose ${row.label} (several can be chosen)`}
                className="grid size-3.5 shrink-0 place-items-center rounded-[2px] hover:bg-surface-inset focus-visible:outline-2 focus-visible:outline-focus-ring"
              >
                <span
                  aria-hidden
                  className={[
                    "block size-2 rounded-[1px]",
                    row.chosen ? "ring-[1.5px] ring-fg ring-offset-1 ring-offset-surface-raised" : "",
                  ].join(" ")}
                  style={{ backgroundColor: row.color }}
                />
              </button>
              <button
                type="button"
                onClick={() => onOpen(row.key)}
                title={
                  row.expandable
                    ? `Open ${row.label}`
                    : row.chosen
                      ? `Stop choosing ${row.label}`
                      : `Choose ${row.label}`
                }
                className={[
                  "flex min-w-0 flex-1 items-center gap-1 rounded-[2px] text-left whitespace-nowrap hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring",
                  row.chosen ? "text-fg" : "text-fg-muted",
                ].join(" ")}
              >
                <span className="min-w-0 truncate">{row.label}</span>
                <span className="ml-auto pl-1 text-fg-faint tabular-nums">{row.count.toLocaleString("en")}</span>
                <span aria-hidden className="grid w-2.5 shrink-0 place-items-center text-fg-faint">
                  {row.expandable && <IconChevronRight size={10} stroke={2.25} />}
                </span>
              </button>
            </div>
          ))}
        </div>
        <div
          ref={gridRef}
          role="slider"
          tabIndex={0}
          aria-label="Filter scenes by time"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, n - 1)}
          aria-valuenow={sel[0]}
          aria-valuetext={n ? `${buckets[sel[0]]} – ${buckets[sel[1]]}` : ""}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          className="relative grid min-w-0 flex-1 cursor-crosshair touch-none select-none rounded-md bg-surface-inset p-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          style={{
            gridTemplateColumns: `repeat(${Math.max(1, n)}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${Math.max(1, rows.length)}, ${ROW_H}px)`,
            gap: 1,
          }}
        >
          {rows.map((row, ri) =>
            buckets.map((bucket, ci) => {
              const c = counts[ri]?.[ci] ?? 0
              const inSel = !range || (ci >= range[0] && ci <= range[1])
              return (
                <div
                  key={`${row.key}-${ci}`}
                  className="rounded-[1px] transition-opacity"
                  style={{
                    backgroundColor: c > 0 ? row.color : undefined,
                    opacity: strength(c) * (inSel ? 1 : 0.35) * (row.dimmed ? 0.35 : 1),
                  }}
                  title={`${row.label} · ${bucket} · ${c.toLocaleString("en")} ${c === 1 ? "scene" : "scenes"}`}
                />
              )
            }),
          )}
          {range && (
            <div
              aria-hidden
              className="pointer-events-none rounded-sm bg-action/10 ring-1 ring-action ring-inset"
              style={{ gridColumn: `${range[0] + 1} / ${range[1] + 2}`, gridRow: "1 / -1" }}
            />
          )}
        </div>
      </div>
      {n > 0 && (
        <div className="flex shrink-0 gap-2" style={{ height: AXIS_H }} aria-hidden>
          <div className="shrink-0 font-mono text-[10px]" style={{ width: labelWidth }} />
          <div className="flex flex-1 justify-between font-mono text-[9.5px] text-fg-muted">
            <span>{buckets[0]}</span>
            {n > 2 && <span>{buckets[Math.floor((n - 1) / 2)]}</span>}
            {n > 1 && <span>{buckets[n - 1]}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
