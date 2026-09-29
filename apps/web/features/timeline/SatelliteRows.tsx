"use client"

import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from "react"
import type { TimelineRow } from "./aggregate"

// The satellite rows under the date overview: one row per satellite, one
// column per period, each cell as strong as its scene count. Drag across the
// columns to mark a stretch (the Scenes tab zooms to it on release); click a
// satellite's name to add it to the chosen satellites or take it out (none
// chosen shows every one). Arrows move the marked stretch, Escape clears it.
//
// Drawn here rather than with the design system's DensityTimeline, which
// fixes each cell's strength at 28% to 100% on a straight scale: a satellite
// with far fewer scenes than the busiest one then stays near 28% and all but
// disappears on the dark grid. Here a cell with any scene starts at half
// strength and the scale rises steeply for small counts (square root), still
// shared by every row, so a stronger cell always means more scenes.

type Props = {
  rows: TimelineRow[]
  buckets: string[]
  // counts[row][bucket]
  counts: number[][]
  // Marked columns [first, last], or null.
  range: [number, number] | null
  onRange: (range: [number, number] | null) => void
  // Chosen satellites' row ids; empty when every satellite shows.
  selectedRowIds: string[]
  onRowClick: (id: string) => void
  // Strength of a cell with one scene when the busiest cell is far busier.
  floor: number
}

// Shared with the overview above, so the graph sits exactly over the columns.
const LABEL_W = 92
const ROW_H = 18

export function SatelliteRows({ rows, buckets, counts, range, onRange, selectedRowIds, onRowClick, floor }: Props) {
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
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <div className="flex flex-col gap-px pt-px" style={{ width: LABEL_W }}>
          {rows.map((row) => {
            const chosen = selectedRowIds.includes(row.id)
            const dimmed = selectedRowIds.length > 0 && !chosen
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => onRowClick(row.id)}
                aria-pressed={chosen}
                title={
                  chosen
                    ? `Stop showing ${row.label}`
                    : selectedRowIds.length
                      ? `Show ${row.label} too`
                      : `Show only ${row.label}`
                }
                className={[
                  "flex items-center gap-1.5 truncate text-left font-mono text-[10px] transition-opacity hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
                  dimmed ? "text-fg-muted opacity-45" : chosen ? "text-fg" : "text-fg-muted",
                ].join(" ")}
                style={{ height: ROW_H }}
              >
                <span className="size-2 shrink-0 rounded-[1px]" style={{ backgroundColor: row.color }} aria-hidden />
                <span className="truncate">{row.label}</span>
              </button>
            )
          })}
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
          className="relative grid flex-1 cursor-crosshair touch-none select-none rounded-md bg-surface-inset p-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
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
              const dimmed = selectedRowIds.length > 0 && !selectedRowIds.includes(row.id)
              return (
                <div
                  key={`${row.id}-${ci}`}
                  className="rounded-[1px] transition-opacity"
                  style={{
                    backgroundColor: c > 0 ? row.color : undefined,
                    opacity: strength(c) * (inSel ? 1 : 0.35) * (dimmed ? 0.35 : 1),
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
        <div className="flex" aria-hidden>
          <div style={{ width: LABEL_W + 8 }} />
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
