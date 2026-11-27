"use client"

import { useMemo } from "react"
import { create } from "zustand"
import { type TimelineRow } from "./aggregate"
import { depthOf, findNode, isUnder, SEP, type TreeNode } from "./hierarchy"
import type { DisplayRow } from "./SatelliteRows"
import { intoBounds, type Tally } from "./tally"

// The Scenes tab's rows, one level at a time: the satellites, then the
// sensors of one satellite, then the products of one sensor. Clicking a
// row's name opens it: its rows replace the list and a breadcrumb leads
// back. The coloured square chooses rows to compare at the level on show.
// What shows (the date graph, the scene strip, the map) is the rows chosen,
// or everything in the row opened when none is. That set is the store's
// filter (satelliteFilter), as row keys.

type Agg = { rows: TimelineRow[]; bucketBounds: Array<[number, number]>; extent: [number, number] }

export type Crumb = { label: string; level: number }

// The rows opened, top down, and the rows chosen at each level when the next
// one was opened, so going back brings them back. Kept with the result they
// belong to: they survive a switch to the Session tab and back, and a new
// result starts again at the satellites.
type Focus = { result: unknown; path: string[]; before: string[][] }
const useFocus = create<Focus>()(() => ({ result: null, path: [], before: [] }))
const NONE: string[][] = []
const NO_ROWS: TreeNode[] = []

// Whether the rows show; "Hide rows" holds across tabs and results.
export const useRowsOpen = create<{ open: boolean; toggle: () => void }>()((set) => ({
  open: true,
  toggle: () => set((s) => ({ open: !s.open })),
}))

// A filter saved with a session, read back as the row it was chosen in: two
// chosen LISS3 products reopen among the products of that LISS3. Rows
// chosen in different places reopen at the top.
function pathFrom(chosen: string[]): string[] {
  const parents = new Set(chosen.map((k) => k.split(SEP).slice(0, -1).join(SEP)))
  const parent = parents.size === 1 ? [...parents][0]! : ""
  if (!parent) return []
  const parts = parent.split(SEP)
  return parts.map((_, i) => parts.slice(0, i + 1).join(SEP))
}

const opens = (node: TreeNode) => node.children.length > 0 && depthOf(node.key) < 2

// The row opened (a satellite or a sensor key), or null at the top.
export function useOpened(result: unknown, chosen: string[]): string | null {
  const savedPath = useFocus((s) => (s.result === result ? s.path : null))
  return useMemo(() => (savedPath ?? pathFrom(chosen)).at(-1) ?? null, [savedPath, chosen])
}

// `result` names the result the rows belong to; `base` is its tally (the
// rows and their totals) and `win` the tally of the dates on show (the rows'
// numbers and periods).
export function useDrill(
  result: unknown,
  base: Tally | null,
  win: Tally | null,
  agg: Agg | null,
  chosen: string[],
  setChosen: (keys: string[]) => void,
) {
  const tree = base?.tree ?? NO_ROWS
  const savedPath = useFocus((s) => (s.result === result ? s.path : null))
  const before = useFocus((s) => (s.result === result ? s.before : NONE))
  const path = useMemo(() => savedPath ?? pathFrom(chosen), [savedPath, chosen])
  const setFocus = (p: string[], b: string[][]) => useFocus.setState({ result, path: p, before: b })
  const level = path.length

  const nodesAt = (at: number) => (at ? (findNode(tree, path[at - 1]!)?.children ?? []) : tree)
  const nodes = useMemo(() => (path.length ? (findNode(tree, path.at(-1)!)?.children ?? []) : tree), [tree, path])
  const ticked = chosen.filter((k) => nodes.some((n) => n.key === k))

  const counts = useMemo(
    () =>
      agg && win
        ? nodes.map((n) => intoBounds(win.rows.get(n.key) ?? [], agg.bucketBounds, agg.extent, win.step))
        : [],
    [win, agg, nodes],
  )

  const colorOf = useMemo(() => {
    const m = new Map((agg?.rows ?? []).map((r) => [r.id, r.color]))
    return (key: string) => m.get(key.split(SEP)[0]!) ?? "var(--bx-slate-500)"
  }, [agg])

  const rows: DisplayRow[] = nodes.map((node, i) => ({
    key: node.key,
    label: node.label,
    color: colorOf(node.key),
    count: (counts[i] ?? []).reduce((a, b) => a + b, 0),
    expandable: opens(node),
    chosen: ticked.includes(node.key),
    // Rows outside the scenes on show fade, as unchosen satellites did.
    dimmed: chosen.length > 0 && !chosen.some((k) => isUnder(node.key, k)),
  }))

  // Choosing none, or every row on show, is the same as showing everything
  // in the row opened (or, at the top, every satellite).
  const choose = (at: number, next: string[]) =>
    setChosen(next.length && next.length < nodesAt(at).length ? next : at ? [path[at - 1]!] : [])

  const onChoose = (key: string) => choose(level, ticked.includes(key) ? ticked.filter((k) => k !== key) : [...ticked, key])

  // Opening a row shows everything in it, whatever else was chosen.
  const onOpen = (key: string) => {
    const node = nodes.find((n) => n.key === key)
    if (!node) return
    if (!opens(node)) return onChoose(key)
    setFocus([...path, key], [...before, chosen])
    setChosen([key])
  }

  // Back to a level: the rows chosen there before come back. A session
  // reopened inside a row has no record of them; its opened row comes back
  // chosen, so the scenes on show stay the same.
  const goTo = (to: number) => {
    if (to >= level) return
    const back = before[to]
    setFocus(path.slice(0, to), before.slice(0, to))
    if (back) setChosen(back)
    else choose(to, [path[to]!])
  }

  const crumbs: Crumb[] = [
    { label: "All satellites", level: 0 },
    ...path.map((key, i) => ({ label: findNode(tree, key)?.label ?? key, level: i + 1 })),
  ]

  // The name column fits the longest name in the result, so names are never
  // cut and the graph keeps its width from level to level. The square, the
  // gaps, the count's padding and the chevron take 48 px; the column never
  // takes more than half the tab, so the graph keeps the rest.
  const chars = useMemo(() => {
    let w = 0
    const walk = (ns: TreeNode[]) => {
      for (const n of ns) {
        w = Math.max(w, n.label.length + String(n.count).length)
        walk(n.children)
      }
    }
    walk(tree)
    return w
  }, [tree])
  const labelWidth = `clamp(92px, calc(${chars}ch + 48px), 50%)`

  const reset = () => setFocus([], [])

  return { rows, counts, labelWidth, crumbs, level, onOpen, onChoose, goTo, reset }
}
