"use client"

import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react"
import { IconX } from "@tabler/icons-react"
import { axisTicks, DAY_MS, formatDay, spanText, stepLabel, type Overview } from "./aggregate"

// The overview at the top of the Scenes tab: the scenes' dates as a filled
// graph (the chosen satellites together, or every satellite when none are
// chosen), with a window over it that chooses the dates. Drag either handle
// to change one end, drag the window to move it, drag anywhere else to draw a
// new one, double-click for all dates. The handles are sliders for the
// keyboard: arrows move one period (Shift for ten), Home and End go to the
// ends.
//
// The window moves at full frame rate; the chosen dates reach the store (and
// with them the matrix, the scene strip and the map) at most every 60 ms
// while dragging, and at once on release.

type Range = [number, number]

type Props = {
  data: Overview
  // The chosen dates, [first ms, last ms] both inclusive, or null for all.
  range: Range | null
  onRange: (range: Range | null) => void
}

type Drag = { mode: "start" | "end" | "move" | "new"; anchor: number; from: Range; x0: number; moved: boolean }

const W = 1000
const H = 100
// Graph colours per theme. Both lines stay at 3:1 or more on the graph's
// background in both themes (accent 5.0:1 light, 7.5:1 dark; the grey 4.2:1
// and 3.9:1), the level WCAG asks of lines that carry meaning.
const COLORS = {
  "--tl-accent": "light-dark(var(--bx-sky-600), var(--bx-sky-400))",
  "--tl-grey": "var(--bx-slate-500)",
} as CSSProperties

const floorDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS
const stepMs = { day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS, year: 365 * DAY_MS }

export function TimeOverview({ data, range, onRange }: Props) {
  const [lo, hi] = data.extent
  const span = Math.max(DAY_MS, hi - lo)
  const trackRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [draft, setDraft] = useState<Range | null>(null)
  const [hover, setHover] = useState<{ x: number; i: number } | null>(null)
  const pending = useRef<{ range: Range | null } | null>(null)
  const timer = useRef<number | null>(null)
  const ids = useId().replace(/[^a-zA-Z0-9_-]/g, "")

  // The window as [start, end) in whole days inside the extent.
  const clamp = (ms: number) => Math.min(hi, Math.max(lo, ms))
  const committed: Range = range
    ? [clamp(floorDay(range[0])), clamp(Math.max(floorDay(range[1]) + DAY_MS, floorDay(range[0]) + DAY_MS))]
    : [lo, hi]
  const win = draft ?? committed
  const all = win[0] <= lo && win[1] >= hi
  const pct = (ms: number) => ((ms - lo) / span) * 100

  const toStore = ([s, e]: Range): Range | null => (s <= lo && e >= hi ? null : [s, e - 1])
  const flush = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    if (pending.current) {
      onRange(pending.current.range)
      pending.current = null
    }
  }
  const push = (w: Range) => {
    setDraft(w)
    pending.current = { range: toStore(w) }
    if (timer.current === null) timer.current = window.setTimeout(flush, 60)
  }

  const msAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect()
    return lo + Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1))) * span
  }
  const snap = (ms: number) => clamp(Math.round(ms / DAY_MS) * DAY_MS)

  const begin = (e: PointerEvent, mode: Drag["mode"]) => {
    if (e.button !== 0) return
    e.stopPropagation()
    trackRef.current?.setPointerCapture(e.pointerId)
    drag.current = { mode, anchor: msAt(e.clientX), from: win, x0: e.clientX, moved: false }
    setHover(null)
  }

  const onMove = (e: PointerEvent) => {
    const d = drag.current
    const ms = msAt(e.clientX)
    if (!d) {
      const i = bucketAt(data.bounds, ms)
      const r = trackRef.current!.getBoundingClientRect()
      setHover({ x: ((e.clientX - r.left) / (r.width || 1)) * 100, i })
      return
    }
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return
    d.moved = true
    const [s, t] = d.from
    if (d.mode === "start") push([Math.min(snap(ms), t - DAY_MS), t])
    else if (d.mode === "end") push([s, Math.max(snap(ms), s + DAY_MS)])
    else if (d.mode === "move") {
      const width = t - s
      const start = Math.min(hi - width, Math.max(lo, s + Math.round((ms - d.anchor) / DAY_MS) * DAY_MS))
      push([start, start + width])
    } else {
      const a = snap(d.anchor)
      const b = snap(ms)
      push(a === b ? [a, Math.min(hi, a + DAY_MS)] : [Math.min(a, b), Math.max(a, b)])
    }
  }

  const onUp = (e: PointerEvent) => {
    const d = drag.current
    drag.current = null
    trackRef.current?.releasePointerCapture(e.pointerId)
    // A click (no drag) outside the window centres the window there.
    if (d && !d.moved && d.mode === "new" && !all) {
      const width = win[1] - win[0]
      const start = Math.min(hi - width, Math.max(lo, snap(d.anchor - width / 2)))
      push([start, start + width])
    }
    flush()
    setDraft(null)
  }

  const onKey = (which: "start" | "end") => (e: KeyboardEvent) => {
    const one = stepMs[data.step]
    const [s, t] = win
    let next: Range | null = null
    const by = (d: number) =>
      which === "start" ? [Math.min(t - DAY_MS, clamp(floorDay(s + d))), t] : [s, Math.max(s + DAY_MS, clamp(floorDay(t + d)))]
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = by(-(e.shiftKey ? 10 * one : one)) as Range
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = by(e.shiftKey ? 10 * one : one) as Range
    else if (e.key === "PageDown") next = by(-10 * one) as Range
    else if (e.key === "PageUp") next = by(10 * one) as Range
    else if (e.key === "Home") next = which === "start" ? [lo, t] : [s, s + DAY_MS]
    else if (e.key === "End") next = which === "start" ? [t - DAY_MS, t] : [s, hi]
    if (!next) return
    e.preventDefault()
    onRange(toStore(next))
  }

  // The graph: scenes per period on a straight scale, so busy stretches stand
  // tall and gaps read as flat; a period with any scene keeps a sliver of
  // height, and the hover label gives the exact count.
  const { area, line } = useMemo(() => {
    const peak = Math.max(1, ...data.counts)
    const x = (ms: number) => Math.min(W, Math.max(0, ((ms - lo) / span) * W))
    const y = (c: number) => (c === 0 ? H : H - Math.max(5, (c / peak) * (H - 6)))
    let top = ""
    data.bounds.forEach(([s, e], i) => {
      const yy = y(data.counts[i] ?? 0).toFixed(1)
      top += `${i === 0 ? "M" : "L"}${x(s).toFixed(1)},${yy}L${x(e).toFixed(1)},${yy}`
    })
    const first = x(data.bounds[0]?.[0] ?? lo).toFixed(1)
    const last = x(data.bounds.at(-1)?.[1] ?? hi).toFixed(1)
    return { line: top, area: `M${first},${H}${top.replace(/^M/, "L")}L${last},${H}Z` }
  }, [data, lo, span, hi])

  const ticks = useMemo(
    // Labels too close to an end would hang off the graph.
    () => axisTicks(lo, hi).filter((t) => (t.ms - lo) / span > 0.03 && (t.ms - lo) / span < 0.97),
    [lo, hi, span],
  )
  const days = Math.round((hi - lo) / DAY_MS)
  const x0 = (pct(win[0]) / 100) * W
  const x1 = (pct(win[1]) / 100) * W
  const hovered = hover ? data.bounds[hover.i] : null

  return (
    <div className="flex gap-2" style={COLORS}>
      <div className="flex w-[92px] shrink-0 flex-col justify-center gap-px font-mono leading-[14px]">
        <span className="text-[10.5px] font-semibold text-fg">{formatDay(win[0])}</span>
        <span className="text-[10.5px] font-semibold text-fg">{formatDay(win[1] - DAY_MS)}</span>
        <span className="flex items-center gap-1 text-[10px] text-fg-muted">
          {spanText(win[1] - win[0])}
          {!all && (
            <button
              type="button"
              onClick={() => onRange(null)}
              aria-label="Show all dates"
              title="All dates"
              className="-my-1 rounded p-0.5 text-fg-muted hover:bg-surface-inset hover:text-fg focus-visible:outline-2 focus-visible:outline-focus-ring"
            >
              <IconX size={11} stroke={2.25} />
            </button>
          )}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div
          ref={trackRef}
          onPointerDown={(e) => begin(e, "new")}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={() => setHover(null)}
          onDoubleClick={() => onRange(null)}
          className="relative h-11 cursor-crosshair touch-none select-none rounded-md bg-surface-inset"
          aria-label="Scenes over time; drag to choose dates"
          role="group"
        >
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
            <defs>
              <linearGradient id={`${ids}-fill`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style={{ stopColor: "var(--tl-accent)", stopOpacity: 0.5 }} />
                <stop offset="1" style={{ stopColor: "var(--tl-accent)", stopOpacity: 0.08 }} />
              </linearGradient>
              <clipPath id={`${ids}-win`}>
                <rect x={x0} y={-2} width={Math.max(0, x1 - x0)} height={H + 4} />
              </clipPath>
            </defs>
            <path d={area} style={{ fill: "var(--tl-grey)", fillOpacity: 0.22 }} />
            <path d={line} vectorEffect="non-scaling-stroke" style={{ fill: "none", stroke: "var(--tl-grey)", strokeWidth: 1 }} />
            <g clipPath={`url(#${ids}-win)`}>
              <path d={area} style={{ fill: `url(#${ids}-fill)` }} />
              <path d={line} vectorEffect="non-scaling-stroke" style={{ fill: "none", stroke: "var(--tl-accent)", strokeWidth: 1.5 }} />
            </g>
          </svg>

          {/* The window: dragged to move it. With every date chosen it lets
              presses through, so a drag on the graph draws a new window. Only
              a light wash marks it; the two lines at its ends do the rest. */}
          <div
            onPointerDown={(e) => begin(e, "move")}
            className={["absolute inset-y-0", all ? "pointer-events-none" : "cursor-grab active:cursor-grabbing"].join(" ")}
            style={{
              left: `${pct(win[0])}%`,
              width: `max(2px, ${pct(win[1]) - pct(win[0])}%)`,
              background: all ? undefined : "color-mix(in srgb, var(--tl-accent) 8%, transparent)",
            }}
          />

          {/* Each end: a 2px line down the graph with a small grip at its
              middle, inside a 16px-wide grab zone. */}
          {(["start", "end"] as const).map((which) => {
            const at = which === "start" ? win[0] : win[1]
            return (
              <div
                key={which}
                role="slider"
                tabIndex={0}
                aria-label={which === "start" ? "From date" : "To date"}
                aria-valuemin={0}
                aria-valuemax={days}
                aria-valuenow={Math.round((at - lo) / DAY_MS)}
                aria-valuetext={formatDay(which === "start" ? at : at - DAY_MS)}
                onPointerDown={(e) => begin(e, which)}
                onKeyDown={onKey(which)}
                className="group/handle absolute inset-y-0 z-10 flex w-4 -translate-x-1/2 cursor-ew-resize justify-center rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
                style={{ left: `${pct(at)}%` }}
              >
                <span
                  aria-hidden
                  className="h-full w-0.5 transition-[width] duration-100 group-hover/handle:w-[3px] motion-reduce:transition-none"
                  style={{ background: "var(--tl-accent)" }}
                />
                <span
                  aria-hidden
                  className="absolute top-1/2 h-3.5 w-1.5 -translate-y-1/2 rounded-full transition-transform duration-100 group-hover/handle:scale-y-125 motion-reduce:transition-none"
                  style={{ background: "var(--tl-accent)", boxShadow: "0 0 0 1.5px var(--bx-surface-inset)" }}
                />
              </div>
            )
          })}

          {hover && hovered && (
            <>
              <div className="pointer-events-none absolute inset-y-0 w-px bg-fg-muted/60" style={{ left: `${hover.x}%` }} />
              {/* Inside the graph's top edge: above it, the tab's scroll area would clip it. */}
              <div
                className="pointer-events-none absolute top-0.5 z-20 rounded border border-border-default bg-surface-raised px-1.5 py-px font-mono text-[10px] whitespace-nowrap text-fg shadow-sm"
                style={{
                  left: `${hover.x}%`,
                  transform: `translateX(${hover.x < 20 ? "6px" : hover.x > 80 ? "calc(-100% - 6px)" : "-50%"})`,
                }}
              >
                {stepLabel(hovered[0], data.step)} · {(data.counts[hover.i] ?? 0).toLocaleString("en")}{" "}
                {data.counts[hover.i] === 1 ? "scene" : "scenes"}
              </div>
            </>
          )}
        </div>

        <div className="relative h-3.5 font-mono text-[9.5px] text-fg-muted" aria-hidden>
          {ticks.map((t) => (
            <span key={t.ms} className="absolute top-0.5 -translate-x-1/2" style={{ left: `${pct(t.ms)}%` }}>
              {t.label}
            </span>
          ))}
        </div>

        {/* Joins the window to the full width of the rows below, which show
            the same dates spread out. Its space is kept when every date is
            chosen, so the rows do not jump when a drag starts. */}
        <svg viewBox="0 0 100 10" preserveAspectRatio="none" className="block h-2.5 w-full" aria-hidden>
          {!all && (
            <path
              d={`M${pct(win[0]).toFixed(2)},0 L${pct(win[1]).toFixed(2)},0 L100,10 L0,10 Z`}
              style={{ fill: "var(--tl-accent)", fillOpacity: 0.12 }}
            />
          )}
        </svg>
      </div>
    </div>
  )
}

// Index of the period holding `ms`.
function bucketAt(bounds: Array<[number, number]>, ms: number): number {
  let lo = 0
  let hi = bounds.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (bounds[mid]![0] <= ms) lo = mid
    else hi = mid - 1
  }
  return lo
}
