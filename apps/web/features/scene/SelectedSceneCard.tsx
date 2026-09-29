"use client"

import { useEffect } from "react"
import { AnimatePresence, motion } from "motion/react"
import { useChatStore } from "@/features/chat/store"
import { usePaletteStore } from "@/features/palette/store"
import { QuicklookControl } from "@/features/map/QuicklookControl"
import { SceneDetailCard } from "./SceneDetailCard"

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
