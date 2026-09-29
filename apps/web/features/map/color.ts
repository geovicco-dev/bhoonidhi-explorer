// WebGL cannot read CSS custom properties, so map layers resolve theme tokens
// to rgb() here. Reading a custom property directly returns unsubstituted
// var() text; setting it on a real property yields the computed colour.

const FALLBACK_COLOR = "#64748b"

export function resolveColor(varName: string): string {
  const probe = document.createElement("span")
  probe.style.color = `var(${varName})`
  probe.style.display = "none"
  document.body.appendChild(probe)
  const rgb = getComputedStyle(probe).color
  probe.remove()
  return rgb || FALLBACK_COLOR
}
