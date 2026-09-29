"use client"

import { useEffect } from "react"
import { IconEye, IconEyeOff } from "@tabler/icons-react"
import { isTypingTarget } from "@/lib/typing"
import { useQuicklookStore } from "./quicklook"

// The quicklook's controls, in a strip just above the scene card at the
// bottom of the map: hide or show the image (also O) and set its opacity.
// The strip appears with the card and keeps its height; until the image
// arrives from ISRO's host, the slider is greyed out and says it is loading.

const BUTTON =
  "flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-surface-inset hover:text-fg focus-visible:outline-2 focus-visible:outline-focus-ring disabled:opacity-40 disabled:hover:bg-transparent"

// The range input's track and thumb, drawn with the theme's tokens as the
// design system's OpacitySlider draws them.
const RANGE = [
  "h-4 min-w-0 flex-1 cursor-pointer appearance-none bg-transparent disabled:cursor-default disabled:opacity-40",
  "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-surface-inset",
  "[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-surface-inset",
  "[&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-border-strong [&::-webkit-slider-thumb]:bg-action",
  "[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-border-strong [&::-moz-range-thumb]:bg-action",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
].join(" ")

// O hides and shows the quicklook wherever the scene is open (the bottom card
// or the Scenes strip), unless focus is in a text field. The opacity slider
// does not count as one, so O works right after using it.
export function useQuicklookKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.toLowerCase() !== "o") return
      const range = e.target instanceof HTMLInputElement && e.target.type === "range"
      if (isTypingTarget(e.target) && !range) return
      if (!useQuicklookStore.getState().drapedId) return
      e.preventDefault()
      useQuicklookStore.getState().toggleVisible()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}

export function QuicklookControl({ sceneId }: { sceneId: string }) {
  const ready = useQuicklookStore((s) => s.drapedId === sceneId)
  const opacity = useQuicklookStore((s) => s.opacity)
  const visible = useQuicklookStore((s) => s.visible)
  const setOpacity = useQuicklookStore((s) => s.setOpacity)
  const toggleVisible = useQuicklookStore((s) => s.toggleVisible)

  return (
    <div
      role="group"
      aria-label="Quicklook"
      className="bx-surface flex w-[376px] max-w-full items-center gap-2 px-2 py-1 text-[11px]"
      // bx-surface is plain CSS outside Tailwind's layers, so its radius and
      // shadow beat utility classes; they are set inline. No shadow, so none
      // falls across the card below.
      style={{ borderRadius: "var(--bx-radius-lg)", boxShadow: "none" }}
    >
      <button
        type="button"
        onClick={toggleVisible}
        disabled={!ready}
        aria-label={visible ? "Hide quicklook" : "Show quicklook"}
        title={`${visible ? "Hide" : "Show"} quicklook (O)`}
        className={BUTTON}
      >
        {visible ? <IconEye size={14} /> : <IconEyeOff size={14} />}
      </button>
      <span className="shrink-0 text-fg-faint">{ready ? "Opacity" : "Loading quicklook…"}</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={opacity}
        disabled={!ready}
        onChange={(e) => setOpacity(Number(e.target.value))}
        aria-label="Quicklook opacity"
        className={RANGE}
      />
      <span
        className={`w-8 shrink-0 text-right font-mono tabular-nums ${ready && visible ? "text-fg-muted" : "text-fg-faint"} ${
          ready && !visible ? "line-through" : ""
        }`}
      >
        {opacity}%
      </span>
    </div>
  )
}
