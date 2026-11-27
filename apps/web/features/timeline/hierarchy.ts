import type { Scene } from "@/features/chat/types"

// Satellite → sensor → product, read from each scene. A row of the Scenes tab
// is a path down that tree: "R2A", "R2A/LISS3", "R2A/LISS3/L2". The satellite
// part is the scene's satellite code (the id the filter has always used, so
// a saved filter of satellite codes still reads as paths). The sensor and
// product come from the ISRO product token in `selection`, which reads
// "<satellite name>_<sensor>" or "<satellite name>_<sensor>_<product>"; a
// token with no product part is the product bhd calls "Others".

export const SEP = "/"
export const OTHERS = "Others"

export function scenePath(scene: Scene): [satellite: string, sensor: string, product: string] {
  const parts = (scene.selection ?? "").split("_")
  const sensor = parts[1] || scene.sensor || "Unknown"
  const product = parts.slice(2).join("_") || OTHERS
  return [scene.satellite ?? "Unknown", sensor, product]
}

export function sceneKeys(scene: Scene): [string, string, string] {
  const [a, b, c] = scenePath(scene)
  return [a, `${a}${SEP}${b}`, `${a}${SEP}${b}${SEP}${c}`]
}

export const depthOf = (key: string) => key.split(SEP).length - 1
export const isUnder = (key: string, ancestor: string) => key === ancestor || key.startsWith(ancestor + SEP)

// True when the scene falls under one of the chosen rows; none chosen shows
// all.
export function matchesFilter(scene: Scene, chosen: string[]): boolean {
  if (!chosen.length) return true
  const leaf = sceneKeys(scene)[2]
  return chosen.some((k) => isUnder(leaf, k))
}

export interface TreeNode {
  key: string
  label: string
  // Every scene under this node, whatever the dates.
  count: number
  children: TreeNode[]
}

// The tree of every scene in the result, in first-seen order (the order the
// satellite rows have always used, so rows and colours stay put).
export function buildTree(scenes: Scene[], satLabel: (s: Scene) => string): TreeNode[] {
  const roots: TreeNode[] = []
  const byKey = new Map<string, TreeNode>()
  for (const s of scenes) {
    const path = scenePath(s)
    const keys = sceneKeys(s)
    let siblings = roots
    keys.forEach((key, depth) => {
      let node = byKey.get(key)
      if (!node) {
        node = { key, label: depth === 0 ? satLabel(s) : path[depth]!, count: 0, children: [] }
        byKey.set(key, node)
        siblings.push(node)
      }
      node.count += 1
      siblings = node.children
    })
  }
  return roots
}

export function findNode(tree: TreeNode[], key: string): TreeNode | undefined {
  for (const n of tree) {
    if (n.key === key) return n
    if (isUnder(key, n.key)) return findNode(n.children, key)
  }
  return undefined
}
