"use client"

import { useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react"
import { useChatStore } from "@/features/chat/store"
import { AVAILABILITY, AVAILABILITY_ORDER } from "./availability"

// Availability legend panel, top-right, beside the GitHub link (MapOverlay
// places both). Starts open once scenes exist; colours
// come from the same table as the footprints. Below 1024px it gives way to
// LegendStrip under the palette bar, which a phone's palette would cover.
export function AvailabilityLegend() {
  const hasScenes = useChatStore((s) => s.scenes.length > 0)
  const [open, setOpen] = useState(true)

  if (!hasScenes) return null

  return (
    <div data-map-inset="top" className="pointer-events-auto hidden lg:block">
      <div className="bx-surface-strong overflow-hidden rounded-xl shadow-lg">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-inset hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
        >
          Legend
          {open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.ul
              key="rows"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 34 }}
              className="overflow-hidden border-t border-border-default"
            >
              {AVAILABILITY_ORDER.map((state) => {
                const a = AVAILABILITY[state]
                return (
                  <li
                    key={state}
                    className="flex items-center gap-2.5 px-3 py-1.5 text-xs first:pt-2.5 last:pb-2.5"
                  >
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: `var(${a.token})` }}
                    />
                    <span className="w-16 shrink-0 font-medium text-fg">{a.label}</span>
                    <span className="whitespace-nowrap text-[11px] text-fg-faint">{a.meaning}</span>
                  </li>
                )
              })}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

// The legend below 1024px: the four colours and their names on one line,
// just under the palette bar (or under the open panel), whenever scenes are
// on the map. Marked as a top inset so camera fits keep footprints below it.
export function LegendStrip() {
  const hasScenes = useChatStore((s) => s.scenes.length > 0)
  if (!hasScenes) return null

  return (
    <ul
      aria-label="Legend"
      data-legend-strip
      data-map-inset="top"
      className="bx-surface-strong flex w-fit shrink-0 items-center gap-3 px-2.5 py-1 text-[11px] lg:hidden"
      // bx-surface-strong is plain CSS outside Tailwind's layers, so its radius
      // and shadow beat utility classes; they are set inline.
      style={{ borderRadius: "var(--bx-radius-lg)", boxShadow: "none" }}
    >
      {AVAILABILITY_ORDER.map((state) => {
        const a = AVAILABILITY[state]
        return (
          <li key={state} className="flex items-center gap-1.5 whitespace-nowrap font-medium text-fg">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: `var(${a.token})` }} />
            {a.label}
          </li>
        )
      })}
    </ul>
  )
}
