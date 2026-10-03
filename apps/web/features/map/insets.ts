// Screen space covered by the floating UI, as map padding, so camera fits land
// in the part of the map the user can see. Any element marked
// data-map-inset="top|bottom|left|right" counts; its edge plus a margin becomes
// the padding on that side. New floating UI only needs the attribute.

const MARGIN = 24

type Insets = { top: number; right: number; bottom: number; left: number }

export function mapInsets(container: HTMLElement): Insets {
  const box = container.getBoundingClientRect()
  const pad: Insets = { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }
  for (const el of document.querySelectorAll<HTMLElement>("[data-map-inset]")) {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    switch (el.dataset.mapInset) {
      case "top":
        pad.top = Math.max(pad.top, r.bottom - box.top + MARGIN)
        break
      case "bottom":
        pad.bottom = Math.max(pad.bottom, box.bottom - r.top + MARGIN)
        break
      case "left":
        pad.left = Math.max(pad.left, r.right - box.left + MARGIN)
        break
      case "right":
        pad.right = Math.max(pad.right, box.right - r.left + MARGIN)
        break
    }
  }
  // fitBounds fails if the padding leaves no room; keep at least a quarter of
  // the map on each axis.
  const shrink = (a: number, b: number, size: number): [number, number] => {
    const room = size * 0.75
    const total = a + b
    return total <= room ? [a, b] : [(a / total) * room, (b / total) * room]
  }
  ;[pad.top, pad.bottom] = shrink(pad.top, pad.bottom, box.height)
  ;[pad.left, pad.right] = shrink(pad.left, pad.right, box.width)
  return pad
}

// Runs `run` once the floating UI has come to rest: no element marked
// data-map-moving (a panel mid-animation marks itself), and every inset
// element's rect unchanged for STILL_FRAMES frames in a row; or after `maxMs`
// whatever the state. A fit started while a panel moves would measure it
// mid-way: the legend strip rides under the shrinking palette, and the
// palette shrinks just as a scene card appears or an area command flies.
// Returns a cancel function.
const STILL_FRAMES = 2

export function afterInsetsSettle(run: () => void, maxMs = 1000): () => void {
  const start = performance.now()
  let last = ""
  let still = 0
  let id = 0
  const tick = () => {
    const now = [...document.querySelectorAll<HTMLElement>("[data-map-inset]")]
      .map((el) => {
        const r = el.getBoundingClientRect()
        return `${el.dataset.mapInset}:${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`
      })
      .join("|")
    const moving = document.querySelector("[data-map-moving]") !== null
    still = now === last && !moving ? still + 1 : 0
    last = now
    if (still >= STILL_FRAMES || performance.now() - start > maxMs) {
      run()
      return
    }
    id = window.requestAnimationFrame(tick)
  }
  id = window.requestAnimationFrame(tick)
  return () => window.cancelAnimationFrame(id)
}
