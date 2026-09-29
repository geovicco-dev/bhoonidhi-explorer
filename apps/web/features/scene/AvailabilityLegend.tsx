"use client"

import { useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react"
import { useChatStore } from "@/features/chat/store"
import { AVAILABILITY, AVAILABILITY_ORDER } from "./availability"

// Availability legend panel, top-right. Starts open once scenes exist; colours
// come from the same table as the footprints.
export function AvailabilityLegend() {
  const hasScenes = useChatStore((s) => s.scenes.length > 0)
  const [open, setOpen] = useState(true)

  if (!hasScenes) return null

  return (
    <div data-map-inset="top" className="pointer-events-auto absolute right-4 top-4 z-20">
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
