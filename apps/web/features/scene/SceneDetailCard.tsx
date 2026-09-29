"use client"

import { useEffect, useState } from "react"
import { motion } from "motion/react"
import { IconCheck, IconCopy, IconFocus2, IconX } from "@tabler/icons-react"
import { copyText } from "@/lib/clipboard"
import type { Scene } from "@/features/chat/types"
import { AVAILABILITY } from "./availability"
import { sceneHandoff, type Handoff } from "./handoff"

// Ground resolution as the catalogue records it: "5.8 m", "20 m".
function resolution(gsd: number | null | undefined): string {
  return typeof gsd === "number" && gsd > 0 ? `${Number(gsd.toFixed(1))} m` : "—"
}

// Expanded form of a strip card, rendered in place of SceneCard for the
// selected scene. Props only; the timeline panel wires selection and zoom.
type Props = {
  scene: Scene
  onClose: () => void
  onZoom: () => void
}

export function SceneDetailCard({ scene, onClose, onZoom }: Props) {
  const availability = scene.availability ? AVAILABILITY[scene.availability] : null
  // Which copy button last succeeded, shown as a tick for a moment.
  const [copied, setCopied] = useState<"id" | "bhd" | "prompt" | null>(null)
  // Fetched when the card opens, so a copy button copies at once: browsers
  // allow a clipboard write only right after the click.
  const [handoff, setHandoff] = useState<Handoff | null>(null)
  const [handoffError, setHandoffError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    sceneHandoff(scene)
      .then((h) => live && setHandoff(h))
      .catch((e: Error) => live && setHandoffError(e.message))
    return () => {
      live = false
    }
  }, [scene])

  const copy = async (what: "id" | "bhd" | "prompt", text: string) => {
    if (!(await copyText(text))) return
    setCopied(what)
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500)
  }

  return (
    <motion.div
      layout
      initial={{ width: 176, opacity: 0.6 }}
      animate={{ width: 400, opacity: 1 }}
      exit={{ width: 176, opacity: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 34 }}
      // Never wider than the strip.
      style={{ maxWidth: "100%" }}
      className="bx-surface relative flex shrink-0 overflow-hidden rounded-xl border border-action text-fg shadow ring-2 ring-action/30"
    >
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
          <dd className="font-mono">{scene.date_of_pass ?? "—"}</dd>
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
              disabled={!handoff}
              title={
                handoffError ??
                (what === "bhd" ? "Copy the bhd commands that download this scene" : "Copy a prompt for an agent with the bhoonidhi MCP server")
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
            className="inline-flex items-center gap-1 rounded-md border border-border-default px-1.5 py-0.5 text-[10px] font-medium text-fg transition-colors hover:bg-surface-inset focus-visible:outline-2 focus-visible:outline-focus-ring"
          >
            <IconFocus2 size={12} /> Zoom to scene
          </button>
        </div>
      </div>
    </motion.div>
  )
}
