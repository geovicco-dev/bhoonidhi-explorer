"use client"

import { useCallback, useEffect } from "react"
import { AnimatePresence, motion } from "motion/react"
import { useChatStore } from "@/features/chat/store"
import { usePaletteStore } from "@/features/palette/store"
import { QuicklookControl } from "@/features/map/QuicklookControl"
import { DETAIL_CARD_WIDTH, SceneDetailCard } from "./SceneDetailCard"

// Below 1280px the card can reach down onto the map buttons (bottom right) or
// the open credits (bottom left), both marked data-bottom-chrome. There it
// sits just above whichever of them lies under it, and moves back down when
// the credits fold. Wider screens keep it at the bottom, as before.
const CLEAR_CORNERS = "(max-width: 1279.98px)"
// bottom-4: the card's place when nothing is under it.
const BASE = 16
const GAP = 8

// A callback ref for the card's outer box: each card (one per scene, keyed)
// follows the corners for as long as it is mounted, its exit included. The
// place is set without a transition: the camera fit that follows the card's
// appearance measures it, and must see where it ends up.
function useClearOfCorners() {
  return useCallback((card: HTMLDivElement | null) => {
    if (!card) return
    const narrow = window.matchMedia(CLEAR_CORNERS)
    const corners = [...document.querySelectorAll<HTMLElement>("[data-bottom-chrome]")]
    const place = () => {
      let bottom = BASE
      const area = card.offsetParent?.getBoundingClientRect()
      if (narrow.matches && area) {
        // The span the card takes once open (it grows into it), so its place
        // is final before the camera frames the scene above it.
        const half = Math.min(DETAIL_CARD_WIDTH, area.width - 2 * BASE) / 2
        const left = area.left + area.width / 2 - half
        const right = area.left + area.width / 2 + half
        for (const el of corners) {
          const r = el.getBoundingClientRect()
          if (!r.width || !r.height || r.right <= left || r.left >= right) continue
          bottom = Math.max(bottom, area.bottom - r.top + GAP)
        }
      }
      card.style.bottom = `${bottom}px`
    }
    place()
    // The credits change size as they open, fold and gain providers' credits.
    const observer = new ResizeObserver(place)
    for (const el of corners) observer.observe(el)
    narrow.addEventListener("change", place)
    window.addEventListener("resize", place)
    return () => {
      observer.disconnect()
      narrow.removeEventListener("change", place)
      window.removeEventListener("resize", place)
    }
  }, [])
}

// The selected scene's card at the bottom centre while the palette is shrunk
// to its bar, with the quicklook's controls just above it. When it
// appears, the map fits the footprint into the space left between the bar
// and the card.
export function SelectedSceneCard() {
  const expanded = usePaletteStore((s) => s.expanded)
  const scenes = useChatStore((s) => s.scenes)
  const selectedSceneId = useChatStore((s) => s.selectedSceneId)
  const closeScene = useChatStore((s) => s.closeScene)
  const requestZoom = useChatStore((s) => s.requestZoom)
  const clearOfCorners = useClearOfCorners()

  const scene = !expanded && selectedSceneId ? scenes.find((s) => s.id === selectedSceneId) : undefined

  // After the card has laid out, so its height counts in the map padding.
  useEffect(() => {
    if (!scene) return
    const id = window.requestAnimationFrame(() => requestZoom())
    return () => window.cancelAnimationFrame(id)
  }, [scene, requestZoom])

  return (
    <AnimatePresence>
      {scene && (
        <div
          key={scene.id}
          ref={clearOfCorners}
          data-map-inset="bottom"
          className="pointer-events-auto absolute bottom-4 left-1/2 z-20 max-w-[calc(100vw-2rem)] -translate-x-1/2"
        >
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
          >
            <div className="flex flex-col items-center gap-1">
              <QuicklookControl sceneId={scene.id} />
              <SceneDetailCard scene={scene} onClose={closeScene} onZoom={requestZoom} />
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
