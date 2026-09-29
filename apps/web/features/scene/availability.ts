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
