"use client"

import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import type * as maplibregl from "maplibre-gl"
import {
  IconCheck,
  IconCircleDashed,
  IconFocusCentered,
  IconPalette,
  IconPencil,
  IconSquareDashed,
  IconTrash,
} from "@tabler/icons-react"
import { useMap } from "@/features/map/MapProvider"
import {
  MAX_RADIUS_KM,
  MIN_RADIUS_KM,
  aoiBounds,
  aoiSize,
  aoiSizeSpoken,
  aoiTopBottom,
  bearing,
  boxFromCorners,
  circleAt,
  clamp,
  destination,
  distanceKm,
  lonLatAt,
  moveAoi,
  type LonLat,
} from "./geo"
import { useAoiStore } from "./store"
import { AOI_COLOR_TOKEN } from "./useAoiLayer"
import { useAoiShortcuts } from "./useAoiShortcuts"
import type { Aoi, AoiBox, AoiCircle, AoiColor } from "./types"

// What the area of interest shows over the map besides its outline: the card
// below its bottom edge (size, actions, style, typed fields) and the edit
// handles. Positions are set on the elements every map frame, so nothing lags
// a pan.

// The collapsed palette bar ends about here; the card never goes above it.
const TOP_CLEAR = 64
const EDGE = 8

function place(map: maplibregl.Map, root: HTMLElement, shape: Aoi, gap: number) {
  const width = root.clientWidth
  const height = root.clientHeight
  const [w, s, e, n] = aoiBounds(shape)
  const a = map.project([w, n])
  const b = map.project([e, s])
  const offScreen = b.x < 0 || a.x > width || b.y < 0 || a.y > height
  root.style.visibility = offScreen ? "hidden" : ""

  for (const el of root.querySelectorAll<HTMLElement>("[data-lng]")) {
    const p = map.project([Number(el.dataset.lng), Number(el.dataset.lat)])
    el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`
  }
  const card = root.querySelector<HTMLElement>("[data-aoi-card]")
  if (card) {
    // Below the shape, so a fitted area never pushes its card into the palette bar.
    const bottom = map.project(aoiTopBottom(shape).bottom)
    const x = clamp(bottom.x - card.offsetWidth / 2, EDGE, width - card.offsetWidth - EDGE)
    const y = clamp(bottom.y + gap, TOP_CLEAR, height - card.offsetHeight - EDGE)
    card.style.transform = `translate(${x}px, ${y}px)`
  }
}

// Drag a handle: every move proposes a new shape, the release commits it, and
// Esc puts the shape back.
function startDrag(
  e: ReactPointerEvent<HTMLElement>,
  map: maplibregl.Map,
  compute: (at: LonLat, ev: PointerEvent) => Aoi,
) {
  if (e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  const el = e.currentTarget
  const id = e.pointerId
  el.setPointerCapture(id)

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId === id) useAoiStore.getState().setDraft(compute(lonLatAt(map, ev.clientX, ev.clientY), ev))
  }
  const finish = (keep: boolean) => {
    el.removeEventListener("pointermove", onMove)
    el.removeEventListener("pointerup", onUp)
    el.removeEventListener("pointercancel", onCancel)
    window.removeEventListener("keydown", onKey, true)
    if (el.hasPointerCapture(id)) el.releasePointerCapture(id)
    const s = useAoiStore.getState()
    if (keep && s.draft) s.commit(s.draft)
    else s.setDraft(null)
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId === id) finish(true)
  }
  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId === id) finish(false)
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return
    ev.preventDefault()
    ev.stopPropagation()
    finish(false)
  }
  el.addEventListener("pointermove", onMove)
  el.addEventListener("pointerup", onUp)
  el.addEventListener("pointercancel", onCancel)
  window.addEventListener("keydown", onKey, true)
}

function Handle({
  at,
  cursor,
  label,
  round,
  color,
  onPointerDown,
}: {
  at: LonLat
  cursor: string
  label: string
  round?: boolean
  color: AoiColor
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
}) {
  return (
    <div
      data-lng={at[0]}
      data-lat={at[1]}
      role="presentation"
      title={label}
      onPointerDown={onPointerDown}
      className="pointer-events-auto absolute top-0 left-0 flex size-5 touch-none items-center justify-center"
      style={{ cursor }}
    >
      <span
        className={["block size-2.5 border-2 bg-white shadow-sm", round ? "rounded-full" : "rounded-[2px]"].join(" ")}
        style={{ borderColor: `var(${AOI_COLOR_TOKEN[color]})` }}
      />
    </div>
  )
}

type BoxHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"

const BOX_CURSOR: Record<BoxHandle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
}

// Dragging an edge moves that edge; a corner moves its two edges. Past the
// opposite side the box flips instead of turning inside out.
function resizeBox(from: AoiBox, handle: BoxHandle, at: LonLat): AoiBox {
  let { west, south, east, north } = from
  if (handle.includes("w")) west = at[0]
  if (handle.includes("e")) east = at[0]
  if (handle.includes("n")) north = at[1]
  if (handle.includes("s")) south = at[1]
  return boxFromCorners([west, south], [east, north])
}

function BoxHandles({ map, box, color }: { map: maplibregl.Map; box: AoiBox; color: AoiColor }) {
  const midLon = (box.west + box.east) / 2
  const midLat = (box.south + box.north) / 2
  const points: Record<BoxHandle, LonLat> = {
    nw: [box.west, box.north],
    n: [midLon, box.north],
    ne: [box.east, box.north],
    e: [box.east, midLat],
    se: [box.east, box.south],
    s: [midLon, box.south],
    sw: [box.west, box.south],
    w: [box.west, midLat],
  }
  return (
    <>
      {(Object.keys(points) as BoxHandle[]).map((h) => (
        <Handle
          key={h}
          at={points[h]}
          cursor={BOX_CURSOR[h]}
          label="Drag to resize"
          round={h.length === 1}
          color={color}
          onPointerDown={(e) => startDrag(e, map, (at) => resizeBox(box, h, at))}
        />
      ))}
    </>
  )
}

function CircleHandles({ map, circle, color }: { map: maplibregl.Map; circle: AoiCircle; color: AoiColor }) {
  // The radius handle stays where it was last let go, instead of jumping back east.
  const [handleBearing, setHandleBearing] = useState(90)
  const center: LonLat = [circle.lon, circle.lat]
  return (
    <>
      <Handle
        at={center}
        cursor="move"
        label="Drag to move"
        round
        color={color}
        onPointerDown={(e) => {
          const start = lonLatAt(map, e.clientX, e.clientY)
          startDrag(e, map, (at) => moveAoi(circle, at[0] - start[0], at[1] - start[1]))
        }}
      />
      <Handle
        at={destination(center, circle.radius_km, handleBearing)}
        cursor="grab"
        label={`Drag to change the radius (${MIN_RADIUS_KM} to ${MAX_RADIUS_KM} km)`}
        round
        color={color}
        onPointerDown={(e) =>
          startDrag(e, map, (at) => {
            setHandleBearing(bearing(center, at))
            return circleAt(center, distanceKm(center, at))
          })
        }
      />
    </>
  )
}

// --- typed fields --------------------------------------------------------------

type FieldKey = "west" | "south" | "east" | "north" | "lat" | "lon" | "radius_km"

const FIELDS: Record<Aoi["kind"], { key: FieldKey; label: string; title: string }[]> = {
  bbox: [
    { key: "west", label: "W", title: "West longitude" },
    { key: "south", label: "S", title: "South latitude" },
    { key: "east", label: "E", title: "East longitude" },
    { key: "north", label: "N", title: "North latitude" },
  ],
  circle: [
    { key: "lat", label: "Lat", title: "Centre latitude" },
    { key: "lon", label: "Lon", title: "Centre longitude" },
    { key: "radius_km", label: "r km", title: `Radius, ${MIN_RADIUS_KM} to ${MAX_RADIUS_KM} km` },
  ],
}

function valueOf(shape: Aoi, key: FieldKey): number {
  return (shape as unknown as Record<FieldKey, number>)[key]
}

function format(key: FieldKey, v: number): string {
  return key === "radius_km" ? String(Math.round(v * 10) / 10) : v.toFixed(4)
}

function inRange(key: FieldKey, v: number): boolean {
  if (key === "radius_km") return v >= MIN_RADIUS_KM && v <= MAX_RADIUS_KM
  if (key === "west" || key === "east" || key === "lon") return v >= -180 && v <= 180
  return v >= -85 && v <= 85
}

// The shape with some fields replaced; null if any value is out of range.
function withValues(shape: Aoi, values: Partial<Record<FieldKey, number>>): Aoi | null {
  for (const [k, v] of Object.entries(values)) if (!inRange(k as FieldKey, v)) return null
  if (shape.kind === "bbox") {
    const b = { ...shape, ...values }
    return boxFromCorners([b.west, b.south], [b.east, b.north])
  }
  const c = { ...shape, ...values }
  return circleAt([c.lon, c.lat], c.radius_km)
}

function EditFields({ shape }: { shape: Aoi }) {
  const commit = useAoiStore((s) => s.commit)
  const setEditing = useAoiStore((s) => s.setEditing)
  const focusFields = useAoiStore((s) => s.focusFields)
  // Only fields the user is typing in; the rest show the live shape.
  const [typed, setTyped] = useState<Partial<Record<FieldKey, string>>>({})
  const [invalid, setInvalid] = useState<FieldKey | null>(null)
  const first = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!focusFields) return
    first.current?.focus()
    useAoiStore.setState({ focusFields: false })
  }, [focusFields])

  const apply = (key: FieldKey): boolean => {
    const text = typed[key]
    if (text === undefined) return true
    const next = withValues(shape, { [key]: Number(text) })
    if (!text.trim() || !next) {
      setInvalid(key)
      return false
    }
    setTyped((t) => {
      const rest = { ...t }
      delete rest[key]
      return rest
    })
    setInvalid(null)
    commit(next)
    return true
  }

  // Pasting a list of numbers fills every field: W, S, E, N or lat, lon, radius.
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const numbers = (e.clipboardData.getData("text").match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    const keys = FIELDS[shape.kind].map((f) => f.key)
    const need = shape.kind === "bbox" ? 4 : 2
    if (numbers.length < need) return
    e.preventDefault()
    const values = Object.fromEntries(keys.slice(0, numbers.length).map((k, i) => [k, numbers[i]!]))
    const next = withValues(shape, values)
    if (!next) return
    setTyped({})
    setInvalid(null)
    commit(next)
  }

  return (
    <div className="bx-surface-strong flex items-center gap-2 rounded-md px-2 py-1 text-[11px] shadow-md">
      {FIELDS[shape.kind].map((f, i) => (
        <label key={f.key} className="flex items-center gap-1" title={f.title}>
          <span className="text-fg-faint">{f.label}</span>
          <input
            ref={i === 0 ? first : undefined}
            value={typed[f.key] ?? format(f.key, valueOf(shape, f.key))}
            inputMode="decimal"
            spellCheck={false}
            aria-label={f.title}
            aria-invalid={invalid === f.key || undefined}
            title={i === 0 ? `${f.title}. Paste ${shape.kind === "bbox" ? "W, S, E, N" : "lat, lon, radius"} to fill every field.` : f.title}
            onChange={(e) => setTyped((t) => ({ ...t, [f.key]: e.target.value }))}
            onPaste={onPaste}
            onBlur={() => apply(f.key)}
            onKeyDown={(e) => {
              // Handled here, so the map's shortcuts do not also act on it.
              e.stopPropagation()
              if (e.key === "Enter") {
                e.preventDefault()
                if (apply(f.key)) setEditing(false)
              } else if (e.key === "Escape") {
                e.preventDefault()
                setTyped({})
                setEditing(false)
              }
            }}
            className={[
              "rounded bg-surface-inset px-1 py-0.5 font-mono text-[11px] text-fg outline-none focus-visible:outline-2 focus-visible:outline-focus-ring",
              f.key === "radius_km" ? "w-12" : "w-[4.75rem]",
              invalid === f.key ? "outline-2 outline-danger" : "",
            ].join(" ")}
          />
        </label>
      ))}
    </div>
  )
}

// --- the card ----------------------------------------------------------------------

const COLORS: { id: AoiColor; label: string }[] = [
  { id: "red", label: "Red" },
  { id: "amber", label: "Amber" },
  { id: "sky", label: "Blue" },
  { id: "white", label: "White" },
]

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded bg-surface-inset p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={[
            "rounded-[3px] px-1.5 py-px text-[11px] focus-visible:outline-2 focus-visible:outline-focus-ring",
            value === o.id ? "bg-surface-raised text-fg shadow-sm" : "text-fg-muted hover:text-fg",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function StyleRow() {
  const style = useAoiStore((s) => s.style)
  const setStyle = useAoiStore((s) => s.setStyle)
  return (
    <div className="bx-surface-strong flex items-center gap-2 rounded-md px-2 py-1 shadow-md">
      <div role="radiogroup" aria-label="Colour" className="flex items-center gap-1">
        {COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={style.color === c.id}
            aria-label={c.label}
            title={c.label}
            onClick={() => setStyle({ color: c.id })}
            className={[
              "size-4 rounded-full border border-border-strong focus-visible:outline-2 focus-visible:outline-focus-ring",
              style.color === c.id ? "ring-2 ring-fg ring-offset-1 ring-offset-surface-raised" : "",
            ].join(" ")}
            style={{ backgroundColor: `var(${AOI_COLOR_TOKEN[c.id]})` }}
          />
        ))}
      </div>
      <Segmented
        label="Outline"
        value={style.line}
        onChange={(line) => setStyle({ line })}
        options={[
          { id: "dashed", label: "Dashed" },
          { id: "solid", label: "Solid" },
        ]}
      />
      <Segmented
        label="Fill"
        value={style.fill}
        onChange={(fill) => setStyle({ fill })}
        options={[
          { id: "none", label: "No fill" },
          { id: "light", label: "Fill" },
        ]}
      />
    </div>
  )
}

function ActionButton({
  label,
  shortcut,
  onClick,
  pressed,
  danger,
  children,
}: {
  label: string
  shortcut?: string
  onClick: () => void
  pressed?: boolean
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={shortcut ? `${label} (${shortcut})` : label}
      onClick={onClick}
      className={[
        "flex size-6 items-center justify-center rounded text-fg-muted hover:bg-surface-inset focus-visible:outline-2 focus-visible:outline-focus-ring",
        danger ? "hover:text-danger" : "hover:text-fg",
        pressed ? "bg-surface-inset text-fg" : "",
      ].join(" ")}
    >
      {children}
    </button>
  )
}

function AreaCard({ shape, drawing }: { shape: Aoi; drawing: boolean }) {
  const editing = useAoiStore((s) => s.editing)
  const menuOpen = useAoiStore((s) => s.menuOpen)
  const styleOpen = useAoiStore((s) => s.styleOpen)
  const color = useAoiStore((s) => s.style.color)
  const store = useAoiStore.getState

  const Icon = shape.kind === "circle" ? IconCircleDashed : IconSquareDashed
  const size = aoiSize(shape)
  const showActions = menuOpen && !editing && !drawing

  return (
    // Column-reverse: the size label sits nearest the shape's bottom edge, and
    // the style row and typed fields open below it.
    <div data-aoi-card className="pointer-events-auto absolute top-0 left-0 flex flex-col-reverse items-center gap-1">
      {editing && !drawing && <EditFields shape={shape} />}
      {showActions && styleOpen && <StyleRow />}
      <div className="bx-surface-strong flex items-center rounded-md text-[11px] shadow-md">
        <button
          type="button"
          onClick={() => !drawing && !editing && store().setMenuOpen(!menuOpen)}
          aria-expanded={drawing || editing ? undefined : menuOpen}
          aria-label={`Area of interest${shape.name ? `, ${shape.name}` : ""}, ${aoiSizeSpoken(shape)}${
            drawing || editing ? "" : ". Show actions"
          }`}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-focus-ring"
        >
          <Icon size={12} style={{ color: `var(${AOI_COLOR_TOKEN[color]})` }} />
          {shape.name && <span className="max-w-40 truncate font-medium text-fg">{shape.name}</span>}
          <span className="font-mono text-fg-muted">{size}</span>
        </button>
        {showActions && (
          <div className="flex items-center gap-0.5 border-l border-border-default px-0.5">
            <ActionButton label="Edit" onClick={() => store().setEditing(true)}>
              <IconPencil size={14} />
            </ActionButton>
            <ActionButton label="Style" pressed={styleOpen} onClick={() => store().setStyleOpen(!styleOpen)}>
              <IconPalette size={14} />
            </ActionButton>
            <ActionButton label="Zoom to area" onClick={() => store().flyTo()}>
              <IconFocusCentered size={14} />
            </ActionButton>
            <ActionButton label="Delete" shortcut="Del" danger onClick={() => store().commit(null)}>
              <IconTrash size={14} />
            </ActionButton>
          </div>
        )}
        {editing && !drawing && (
          <div className="flex items-center border-l border-border-default px-0.5">
            <ActionButton label="Done" shortcut="Enter" onClick={() => store().setEditing(false)}>
              <IconCheck size={14} />
            </ActionButton>
          </div>
        )}
      </div>
    </div>
  )
}

export function AoiOverlay() {
  const { map } = useMap()
  const aoi = useAoiStore((s) => s.aoi)
  const draft = useAoiStore((s) => s.draft)
  const editing = useAoiStore((s) => s.editing)
  const color = useAoiStore((s) => s.style.color)
  const rootRef = useRef<HTMLDivElement>(null)
  useAoiShortcuts()

  const shape = draft ?? aoi
  // A draft outside edit mode is a shape being drawn.
  const drawing = !!draft && !editing
  const gap = editing ? 14 : 6

  // After every render, and on every map frame.
  useLayoutEffect(() => {
    if (map && shape && rootRef.current) place(map, rootRef.current, shape, gap)
  })
  useEffect(() => {
    if (!map || !shape) return
    const follow = () => {
      if (rootRef.current) place(map, rootRef.current, shape, gap)
    }
    map.on("move", follow)
    map.on("resize", follow)
    return () => {
      map.off("move", follow)
      map.off("resize", follow)
    }
  }, [map, shape, gap])

  if (!map || !shape) return null
  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 overflow-hidden">
      <AreaCard shape={shape} drawing={drawing} />
      {editing &&
        !drawing &&
        (shape.kind === "bbox" ? (
          <BoxHandles map={map} box={shape} color={color} />
        ) : (
          <CircleHandles map={map} circle={shape} color={color} />
        ))}
    </div>
  )
}
