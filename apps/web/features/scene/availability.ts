import type { Scene } from "@/features/chat/types"

type Availability = NonNullable<Scene["availability"]>

// Label, meaning and colour per availability state, shared by footprints,
// legend and detail pill. Words follow bhoonidhi-downloader's Availability
// column. On order is amber-500 in both themes.
export const AVAILABILITY: Record<
  Availability,
  { label: string; meaning: string; token: string }
> = {
  Ready: {
    label: "Ready",
    meaning: "Open data, download now",
    token: "--color-success",
  },
  Archived: {
    label: "Archived",
    meaning: "Open data, request on the portal",
    token: "--color-info",
  },
  OnOrder: {
    label: "On order",
    meaning: "Order on the portal",
    token: "--bx-amber-500",
  },
  Priced: {
    label: "Priced",
    meaning: "Paid product",
    token: "--color-danger",
  },
}

// Display order for the legend.
export const AVAILABILITY_ORDER: Availability[] = ["Ready", "Archived", "OnOrder", "Priced"]

// Only Ready scenes get the CLI and MCP hand-off: bhd tries an Archived scene
// and may fail, and skips On order and Priced ones.
export const isReady = (scene: Scene) => scene.availability === "Ready"

// Why a scene that is not Ready has no hand-off, as its buttons' tooltip.
const PORTAL_HINT: Record<Exclude<Availability, "Ready">, string> = {
  Archived: "Archived: request this scene on the Bhoonidhi portal",
  OnOrder: "On order: order this scene on the Bhoonidhi portal",
  Priced: "Priced: a paid product, ordered on the Bhoonidhi portal",
}

export function portalHint(scene: Scene): string {
  const a = scene.availability
  return a && a !== "Ready" ? PORTAL_HINT[a] : "No availability recorded: check this scene on the Bhoonidhi portal"
}

// The scenes in a selection that need the portal, in words:
// "5 Archived and 3 On order need the Bhoonidhi portal".
export function portalSummary(scenes: Scene[]): string {
  const counts = new Map<string, number>()
  for (const s of scenes) {
    if (isReady(s)) continue
    const label = s.availability ? AVAILABILITY[s.availability].label : "without availability"
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const order = [...AVAILABILITY_ORDER.map((a) => AVAILABILITY[a].label), "without availability"]
  const parts = order.filter((l) => counts.has(l)).map((l) => `${counts.get(l)!.toLocaleString("en")} ${l}`)
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "")
  return `${list} ${total === 1 ? "needs" : "need"} the Bhoonidhi portal`
}
