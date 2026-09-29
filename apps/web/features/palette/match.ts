import { Fzf } from "fzf"
import type { PaletteItem } from "./types"

export type Match = {
  item: PaletteItem
  // Indexes into item.label of the characters the query matched.
  labelPositions: Set<number>
}

// fzf's scoring (the terminal tool's algorithm), over label + keywords so a
// row can be found by fields it does not display in its main text.
export function matchItems(items: PaletteItem[], query: string): Match[] {
  const q = query.trim()
  if (!q) return items.map((item) => ({ item, labelPositions: new Set() }))
  const fzf = new Fzf(items, {
    selector: (item) => (item.keywords ? `${item.label} ${item.keywords}` : item.label),
    casing: "case-insensitive",
  })
  return fzf.find(q).map((r) => ({
    item: r.item,
    labelPositions: new Set([...r.positions].filter((p) => p < r.item.label.length)),
  }))
}
