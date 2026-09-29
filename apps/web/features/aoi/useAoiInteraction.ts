import { useEffect } from "react"
import type * as maplibregl from "maplibre-gl"
import { useMap } from "@/features/map/MapProvider"
import { dismissPalette } from "@/features/palette/store"
import {
  DEFAULT_RADIUS_KM,
  boxFromCorners,
  circleAt,
  distanceKm,
  insideOnScreen,
  lonLatAt,
  moveAoi,
  outlineDistance,
  type LonLat,
} from "./geo"
import { useAoiStore } from "./store"
import type { Aoi, AoiCircle } from "./types"

// Pointer input on the map for the area of interest: drawing in the armed
// mode or with Shift+drag, clicks on the outline, and moving the area in edit
// mode. Resize handles live in AoiOverlay; pan, zoom and scene clicks stay
// with MapLibre.

// Pixels a press may travel and still count as a click.
const CLICK_SLOP = 4
// Pixels from the outline that still count as on it.
const HIT_PX = 7
// A double-click that ends a shape must not also zoom the map.
const DOUBLE_CLICK_MS = 500

type Gesture =
  | {
      kind: "draw"
      // Armed from the toolbar or a key, not Shift+drag. Only then does Shift
      // mean "keep it square", since Shift+drag is itself the trigger.
      fromTool: boolean
      start: LonLat
      id: number
      moved: boolean
      x: number
      y: number
    }
  // Rectangle: first corner placed with a click; the next click places the opposite one.
  | { kind: "corner"; start: LonLat }
  // Point: centre placed with a click; the circle follows the pointer until the next click.
  | { kind: "centre"; center: LonLat }
  | { kind: "move"; start: LonLat; from: Aoi; id: number; moved: boolean; x: number; y: number }
  | { kind: "outline"; id: number; x: number; y: number }

// Gestures that hold a pressed pointer, as opposed to waiting for the next click.
type PressGesture = Extract<Gesture, { id: number }>
const holdsPointer = (g: Gesture | null): g is PressGesture => !!g && "id" in g

function rectFor(start: LonLat, end: LonLat, square: boolean, map: maplibregl.Map): Aoi {
  if (!square) return boxFromCorners(start, end)
  // Square on screen: the longer side of the drag, in pixels, both ways.
  const a = map.project(start)
  const b = map.project(end)
  const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
  const corner = map.unproject([a.x + Math.sign(b.x - a.x || 1) * side, a.y + Math.sign(b.y - a.y || 1) * side])
  return boxFromCorners(start, [corner.lng, corner.lat])
}

export function useAoiInteraction() {
  const { map } = useMap()

  useEffect(() => {
    if (!map) return
    const container = map.getCanvasContainer()
    const canvas = map.getCanvas()
    const store = useAoiStore
    let gesture: Gesture | null = null
    // A press outside the area while editing: a click ends editing, a drag pans.
    let outsidePress: { id: number; x: number; y: number } | null = null
    // A press in point mode: a click places the centre or the edge, a drag pans.
    let pointPress: { id: number; x: number; y: number } | null = null
    let finishedAt = 0

    const pointAt = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const onOutline = (e: PointerEvent) => {
      const aoi = store.getState().aoi
      return !!aoi && outlineDistance(map, aoi, pointAt(e)) <= HIT_PX
    }
    const onInside = (e: PointerEvent) => {
      const aoi = store.getState().aoi
      return !!aoi && insideOnScreen(map, aoi, pointAt(e))
    }

    // The circle point mode makes for the pointer at `e`: the default radius
    // while the pointer is still on the centre, otherwise out to the pointer.
    const circleTo = (center: LonLat, e: { clientX: number; clientY: number }): AoiCircle => {
      const c = map.project(center)
      const p = pointAt(e)
      if (Math.hypot(p.x - c.x, p.y - c.y) <= CLICK_SLOP) return circleAt(center, DEFAULT_RADIUS_KM)
      return circleAt(center, distanceKm(center, lonLatAt(map, e.clientX, e.clientY)))
    }

    const claim = (e: PointerEvent) => {
      // MapLibre reacts to mouse events, not pointer events; cancelling the
      // pointerdown stops the mousedown that would start a pan or box zoom.
      e.preventDefault()
      container.setPointerCapture(e.pointerId)
      // Hand the keyboard to the map, so Esc and the shortcuts reach the area.
      dismissPalette()
    }

    const setCursor = () => {
      const s = store.getState()
      let cursor = ""
      if (gesture?.kind === "move") cursor = "grabbing"
      else if (s.tool || gesture?.kind === "draw" || gesture?.kind === "corner") cursor = "crosshair"
      else if (s.editing && s.hover) cursor = "move"
      else if (s.hover) cursor = "pointer"
      canvas.style.cursor = cursor
    }

    const release = (pointerId: number) => {
      if (container.hasPointerCapture(pointerId)) container.releasePointerCapture(pointerId)
    }

    const finishShape = (shape: Aoi) => {
      gesture = null
      finishedAt = performance.now()
      const s = store.getState()
      s.commit(shape)
      // One shape per arming: afterwards the map pans again.
      s.setTool(null)
    }

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const s = store.getState()

      if (gesture?.kind === "corner") {
        claim(e)
        release(e.pointerId)
        const first = map.project(gesture.start)
        const here = pointAt(e)
        // A second click on the first corner draws nothing; keep waiting.
        if (Math.hypot(here.x - first.x, here.y - first.y) <= CLICK_SLOP) return
        finishShape(rectFor(gesture.start, lonLatAt(map, e.clientX, e.clientY), e.shiftKey, map))
        setCursor()
        return
      }
      if (s.tool === "point" && !e.shiftKey) {
        // Not claimed, so a drag pans the map; only a click counts (in onUp).
        pointPress = { id: e.pointerId, x: e.clientX, y: e.clientY }
        return
      }
      if (gesture) return

      if (s.tool === "rectangle" || e.shiftKey) {
        claim(e)
        gesture = {
          kind: "draw",
          fromTool: s.tool === "rectangle",
          start: lonLatAt(map, e.clientX, e.clientY),
          id: e.pointerId,
          moved: false,
          x: e.clientX,
          y: e.clientY,
        }
      } else if (s.editing && s.aoi && (onInside(e) || onOutline(e))) {
        claim(e)
        gesture = {
          kind: "move",
          start: lonLatAt(map, e.clientX, e.clientY),
          from: s.aoi,
          id: e.pointerId,
          moved: false,
          x: e.clientX,
          y: e.clientY,
        }
      } else if (!s.editing && onOutline(e)) {
        claim(e)
        gesture = { kind: "outline", id: e.pointerId, x: e.clientX, y: e.clientY }
      } else {
        // Not ours: the map pans as usual. A click here closes the actions.
        if (s.menuOpen) s.setMenuOpen(false)
        if (s.editing) outsidePress = { id: e.pointerId, x: e.clientX, y: e.clientY }
      }
      setCursor()
    }

    const onMove = (e: PointerEvent) => {
      if (gesture?.kind === "centre") {
        store.getState().setDraft(circleTo(gesture.center, e))
        return
      }
      if (!gesture) {
        // Hover feedback only, and only over the map itself.
        const s = store.getState()
        const overMap = e.target instanceof Node && container.contains(e.target)
        if (!s.tool) s.setHover(overMap && (onOutline(e) || (s.editing && onInside(e))))
        setCursor()
        return
      }
      if (gesture.kind === "corner") {
        store.getState().setDraft(rectFor(gesture.start, lonLatAt(map, e.clientX, e.clientY), e.shiftKey, map))
        return
      }
      if (e.pointerId !== gesture.id || gesture.kind === "outline") return
      const travelled = Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > CLICK_SLOP
      if (!gesture.moved && !travelled) return
      gesture.moved = true
      const here = lonLatAt(map, e.clientX, e.clientY)
      if (gesture.kind === "draw") {
        store.getState().setDraft(rectFor(gesture.start, here, gesture.fromTool && e.shiftKey, map))
      } else {
        store.getState().setDraft(moveAoi(gesture.from, here[0] - gesture.start[0], here[1] - gesture.start[1]))
      }
    }

    const onUp = (e: PointerEvent) => {
      if (pointPress && e.pointerId === pointPress.id) {
        const clicked = Math.hypot(e.clientX - pointPress.x, e.clientY - pointPress.y) <= CLICK_SLOP
        pointPress = null
        if (!clicked || store.getState().tool !== "point") return
        if (gesture?.kind === "centre") {
          // The second click sets the edge; on the centre itself, the default radius.
          finishShape(circleTo(gesture.center, e))
        } else {
          dismissPalette()
          const center = lonLatAt(map, e.clientX, e.clientY)
          gesture = { kind: "centre", center }
          store.getState().setDraft(circleAt(center, DEFAULT_RADIUS_KM))
        }
        setCursor()
        return
      }
      if (outsidePress && e.pointerId === outsidePress.id) {
        const clicked = Math.hypot(e.clientX - outsidePress.x, e.clientY - outsidePress.y) <= CLICK_SLOP
        outsidePress = null
        if (clicked) store.getState().setEditing(false)
      }
      if (!holdsPointer(gesture) || e.pointerId !== gesture.id) return
      const g = gesture
      gesture = null
      release(e.pointerId)
      const s = store.getState()

      if (g.kind === "draw") {
        if (g.moved && s.draft) finishShape(s.draft)
        // A click with the rectangle tool places its first corner.
        else if (g.fromTool) gesture = { kind: "corner", start: g.start }
        else s.setDraft(null)
      } else if (g.kind === "move") {
        if (g.moved && s.draft) s.commit(s.draft)
        else s.setDraft(null)
      } else if (Math.hypot(e.clientX - g.x, e.clientY - g.y) <= CLICK_SLOP) {
        // A click on the outline shows the area's actions.
        s.setMenuOpen(true)
      }
      setCursor()
    }

    const cancel = () => {
      if (holdsPointer(gesture)) release(gesture.id)
      gesture = null
      pointPress = null
      store.getState().setDraft(null)
      setCursor()
    }

    const onCancel = (e: PointerEvent) => {
      if (pointPress && e.pointerId === pointPress.id) pointPress = null
      if (holdsPointer(gesture) && e.pointerId === gesture.id) cancel()
    }

    // Esc drops a shape mid-drag. Capture phase, so it runs before the
    // shortcuts, which would otherwise read the same Esc as "disarm the tool".
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !gesture) return
      e.preventDefault()
      e.stopPropagation()
      const wasTool =
        gesture.kind === "corner" || gesture.kind === "centre" || (gesture.kind === "draw" && gesture.fromTool)
      cancel()
      if (wasTool) store.getState().setTool(null)
    }

    // Keep MapLibre from seeing a press this hook has claimed, in case the
    // browser still sends the mouse or touch events for it.
    const swallow = (e: Event) => {
      if (holdsPointer(gesture)) e.stopPropagation()
    }

    // Double-click on the outline edits the area instead of zooming the map.
    const onDblClick = (e: maplibregl.MapMouseEvent) => {
      const s = store.getState()
      // Two clicks on one spot in point mode make a default circle, not a zoom.
      if (s.tool === "point" || performance.now() - finishedAt < DOUBLE_CLICK_MS) {
        e.preventDefault()
        return
      }
      if (s.tool || !s.aoi) return
      const onIt = outlineDistance(map, s.aoi, e.point) <= HIT_PX
      if (onIt || (s.editing && insideOnScreen(map, s.aoi, e.point))) {
        e.preventDefault()
        s.setEditing(true)
      }
    }

    const onLeave = () => {
      if (!gesture) store.getState().setHover(false)
      setCursor()
    }

    // Disarming the tool (Esc, the toolbar) drops a half-drawn shape.
    const unsubscribe = store.subscribe((s, prev) => {
      if (s.tool !== prev.tool) {
        pointPress = null
        if (gesture?.kind === "corner" || gesture?.kind === "centre") {
          gesture = null
          store.getState().setDraft(null)
        }
      }
      if (s.tool !== prev.tool || s.editing !== prev.editing || s.hover !== prev.hover) setCursor()
    })

    container.addEventListener("pointerdown", onDown, true)
    container.addEventListener("mousedown", swallow, true)
    container.addEventListener("touchstart", swallow, { capture: true, passive: true })
    container.addEventListener("pointerleave", onLeave)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    window.addEventListener("keydown", onKey, true)
    map.on("dblclick", onDblClick)

    return () => {
      unsubscribe()
      container.removeEventListener("pointerdown", onDown, true)
      container.removeEventListener("mousedown", swallow, true)
      container.removeEventListener("touchstart", swallow, true)
      container.removeEventListener("pointerleave", onLeave)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      window.removeEventListener("keydown", onKey, true)
      map.off("dblclick", onDblClick)
      canvas.style.cursor = ""
    }
  }, [map])
}
