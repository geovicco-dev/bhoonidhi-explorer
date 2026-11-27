"use client"

import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { IconCheck, IconChevronLeft, IconChevronRight, IconCopy, IconExternalLink, IconFocus2, IconX } from "@tabler/icons-react"
import { copyText } from "@/lib/clipboard"
import type { Scene } from "@/features/chat/types"
import { parseSceneDate } from "@/features/timeline/aggregate"
import { AVAILABILITY, isReady, portalHint } from "./availability"
import type { CellSteps } from "./cellSteps"
import { sceneHandoff, type Handoff } from "./handoff"
import { useStacItemUrl } from "./stacItem"

// Ground resolution as the catalogue records it: "5.8 m", "20 m".
function resolution(gsd: number | null | undefined): string {
  return typeof gsd === "number" && gsd > 0 ? `${Number(gsd.toFixed(1))} m` : "—"
}

// The open card's width; narrower screens cap it.
export const DETAIL_CARD_WIDTH = 400

// How far an arrow on the card's edge reaches past it, so a parent can leave
// room for it.
export const EDGE_ARROW_OVERHANG = 12

// Expanded form of a strip card, rendered in place of SceneCard for the
// selected scene. Props only; the timeline panel wires selection and zoom.
// With `steps`, arrows on the card's left and right edges open the older and
// newer scene of the same footprint, and the card slides to it like a
// carousel: an older scene comes in from the left, a newer one from the
// right.
type Props = {
  scene: Scene
  onClose: () => void
  onZoom: () => void
  steps?: CellSteps | null
  onStep?: (id: string) => void
}

const SLIDE = { type: "tween", ease: [0.32, 0.72, 0, 1], duration: 0.32 } as const
// `custom` is the direction: 1 when the new scene is newer, -1 when older,
// 0 when neither (the card cross-fades in place).
const slide = {
  enter: (d: number) => ({ x: `${d * 100}%`, opacity: d === 0 ? 0 : 1 }),
  center: { x: "0%", opacity: 1 },
  exit: (d: number) => ({ x: `${-d * 100}%`, opacity: d === 0 ? 0 : 1 }),
}

// Which way the card slides when its scene changes: by the place in the
// footprint's steps when both scenes have one, else by the date.
function useSlideDirection(scene: Scene, position: number | undefined): number {
  const [last, setLast] = useState({ id: scene.id, date: scene.date_of_pass, position })
  const [direction, setDirection] = useState(0)
  if (last.id !== scene.id) {
    const was = parseSceneDate(last.date)
    const now = parseSceneDate(scene.date_of_pass)
    const byStep = position !== undefined && last.position !== undefined ? Math.sign(position - last.position) : 0
    const byDate = was !== null && now !== null ? Math.sign(now - was) : 0
    setLast({ id: scene.id, date: scene.date_of_pass, position })
    setDirection(byStep || byDate)
  }
  return direction
}

const EDGE_ARROW =
  "bx-surface absolute top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center text-fg transition-opacity hover:text-action focus-visible:outline-2 focus-visible:outline-focus-ring disabled:opacity-30 disabled:hover:text-fg"

export function SceneDetailCard({ scene, onClose, onZoom, steps, onStep }: Props) {
  const direction = useSlideDirection(scene, steps?.position)
  return (
    // Never wider than the strip.
    <div className="relative shrink-0" style={{ maxWidth: "100%" }}>
      <motion.div
        layout
        initial={{ width: 176, opacity: 0.6 }}
        animate={{ width: DETAIL_CARD_WIDTH, opacity: 1 }}
        exit={{ width: 176, opacity: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 34 }}
        style={{ maxWidth: "100%" }}
        className="bx-surface relative flex shrink-0 overflow-hidden rounded-xl border border-action text-fg shadow ring-2 ring-action/30"
      >
        <AnimatePresence initial={false} mode="popLayout" custom={direction}>
          <motion.div
            key={scene.id}
            custom={direction}
            variants={slide}
            initial="enter"
            animate="center"
            exit="exit"
            transition={SLIDE}
            className="flex min-w-0 flex-1"
          >
            <SceneBody scene={scene} onClose={onClose} onZoom={onZoom} steps={steps} />
          </motion.div>
        </AnimatePresence>
      </motion.div>
      {steps && (
        <>
          <button
            type="button"
            disabled={!steps.older}
            onClick={() => steps.older && onStep?.(steps.older.id)}
            aria-label="Older scene of this footprint"
            title="Older scene of this footprint (,)"
            className={`${EDGE_ARROW} left-0 -translate-x-1/2`}
            // bx-surface sets its own radius outside Tailwind's layers.
            style={{ borderRadius: "9999px" }}
          >
            <IconChevronLeft size={14} stroke={2.25} />
          </button>
          <button
            type="button"
            disabled={!steps.newer}
            onClick={() => steps.newer && onStep?.(steps.newer.id)}
            aria-label="Newer scene of this footprint"
            title="Newer scene of this footprint (.)"
            className={`${EDGE_ARROW} right-0 translate-x-1/2`}
            style={{ borderRadius: "9999px" }}
          >
            <IconChevronRight size={14} stroke={2.25} />
          </button>
        </>
      )}
    </div>
  )
}

// One scene's quicklook, details and actions: the part of the card that
// slides when the scene changes.
function SceneBody({ scene, onClose, onZoom, steps }: Omit<Props, "onStep">) {
  const availability = scene.availability ? AVAILABILITY[scene.availability] : null
  const stacItemUrl = useStacItemUrl(scene)
  // Only a Ready scene has download steps; the others come from the portal.
  const ready = isReady(scene)
  // Which copy button last succeeded, shown as a tick for a moment.
  const [copied, setCopied] = useState<"id" | "bhd" | "prompt" | null>(null)
  // Fetched when the card opens, so a copy button copies at once: browsers
  // allow a clipboard write only right after the click.
  const [handoff, setHandoff] = useState<Handoff | null>(null)
  const [handoffError, setHandoffError] = useState<string | null>(null)

  useEffect(() => {
    if (!ready) return
    let live = true
    sceneHandoff(scene)
      .then((h) => live && setHandoff(h))
      .catch((e: Error) => live && setHandoffError(e.message))
    return () => {
      live = false
    }
  }, [scene, ready])

  const copy = async (what: "id" | "bhd" | "prompt", text: string) => {
    if (!(await copyText(text))) return
    setCopied(what)
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500)
  }

  return (
    <>
      <div
        aria-hidden
        className="relative w-28 shrink-0 bg-surface-inset"
        style={
          scene.quicklook_url
            ? {
                backgroundImage: `url(${scene.quicklook_url})`,
                backgroundSize: "contain",
                backgroundPosition: "center",
                backgroundRepeat: "no-repeat",
              }
            : undefined
        }
      />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {availability && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border-default px-1.5 py-px text-[10px] font-medium">
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: `var(${availability.token})` }}
                />
                {availability.label}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close scene details"
            className="-mr-1 -mt-1 rounded-md p-1 text-fg-faint transition-colors hover:bg-surface-inset hover:text-fg focus-visible:outline-2 focus-visible:outline-focus-ring"
          >
            <IconX size={14} />
          </button>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-[11px]">
          <dt className="text-fg-faint">Scene</dt>
          <dd className="min-w-0">
            <button
              type="button"
              onClick={() => void copy("id", scene.id)}
              title={scene.id}
              className="group flex max-w-full items-center gap-1 font-mono text-fg hover:text-action focus-visible:outline-2 focus-visible:outline-focus-ring"
            >
              <span className="truncate">{scene.id}</span>
              {copied === "id" ? (
                <IconCheck size={12} className="shrink-0 text-success" />
              ) : (
                <IconCopy size={12} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
              )}
            </button>
          </dd>
          <dt className="text-fg-faint">Acquired</dt>
          <dd className="flex min-w-0 items-baseline gap-1.5 font-mono">
            <span>{scene.date_of_pass ?? "—"}</span>
            {steps && (
              <span className="text-[10px] text-fg-faint">
                {steps.position} of {steps.total}
              </span>
            )}
          </dd>
          <dt className="text-fg-faint">Resolution</dt>
          <dd className="font-mono">{resolution(scene.gsd_m)}</dd>
          <dt className="text-fg-faint">Platform</dt>
          <dd className="truncate">
            {[scene.satellite, scene.sensor].filter(Boolean).join(" / ") || "—"}
          </dd>
          <dt className="text-fg-faint">Product</dt>
          <dd className="truncate font-mono text-[10px]">{scene.selection ?? "—"}</dd>
        </dl>

        <div className="mt-auto flex items-center justify-end gap-1 border-t border-border-default pt-1.5">
          {(["bhd", "prompt"] as const).map((what) => (
            <button
              key={what}
              type="button"
              disabled={!ready || !handoff}
              title={
                !ready
                  ? portalHint(scene)
                  : (handoffError ??
                    (what === "bhd"
                      ? "Copy the bhd commands that download this scene"
                      : "Copy a prompt for an agent with the bhoonidhi MCP server"))
              }
              onClick={() => handoff && void copy(what, handoff[what])}
              className="inline-flex items-center gap-1 rounded-md border border-border-default px-1.5 py-0.5 text-[10px] font-medium text-fg transition-colors hover:bg-surface-inset focus-visible:outline-2 focus-visible:outline-focus-ring disabled:opacity-40"
            >
              {copied === what ? <IconCheck size={12} className="text-success" /> : <IconCopy size={12} />}
              {what === "bhd" ? "CLI" : "MCP"}
            </button>
          ))}
          <button
            type="button"
            onClick={onZoom}
            title="Zoom to scene"
            className="inline-flex items-center gap-1 rounded-md border border-border-default px-1.5 py-0.5 text-[10px] font-medium text-fg transition-colors hover:bg-surface-inset focus-visible:outline-2 focus-visible:outline-focus-ring"
          >
            <IconFocus2 size={12} /> Zoom
          </button>
          {/* No link until the API has named the STAC API's address. */}
          <a
            href={stacItemUrl ?? undefined}
            role={stacItemUrl ? undefined : "link"}
            aria-disabled={stacItemUrl ? undefined : true}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this scene's STAC item in a new tab"
            className="inline-flex items-center gap-1 rounded-md border border-border-default px-1.5 py-0.5 text-[10px] font-medium text-fg transition-colors hover:bg-surface-inset focus-visible:outline-2 focus-visible:outline-focus-ring aria-disabled:pointer-events-none aria-disabled:opacity-40"
          >
            <IconExternalLink size={12} /> STAC Item
          </a>
        </div>
      </div>
    </>
  )
}
