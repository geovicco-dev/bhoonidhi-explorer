import type { ReactNode } from "react"

// One row in the palette. A row either runs something (`run`) or opens a
// deeper page (`pageId`); a row with neither is informational.
export type PaletteItem = {
  id: string
  label: string
  // Matched along with the label but not shown in the main text.
  keywords?: string
  // Secondary text on the right (a category, a resolution, a count).
  hint?: ReactNode
  // Optional second line under the label.
  detail?: ReactNode
  icon?: ReactNode
  // Group heading, shown when the query is empty.
  section?: string
  // Only listed once the user types (e.g. older conversations at the root).
  searchOnly?: boolean
  // Stays in the list but cannot be chosen (e.g. "Zoom to scene" with none selected).
  disabled?: boolean
  run?: () => void
  // Shift+Enter or Shift+click: the row's second action, e.g. a place that
  // also becomes the area of interest.
  altRun?: () => void
  pageId?: string
  // Query pre-filled when the page opens (e.g. the current name on a rename page).
  pageQuery?: string
}

export type PalettePage = {
  id: string
  title: string
  placeholder?: string
  items: PaletteItem[]
  loading?: boolean
  error?: string
  // An input page: Enter submits the typed text instead of choosing a row.
  onSubmit?: (text: string) => void
  submitLabel?: string
}
