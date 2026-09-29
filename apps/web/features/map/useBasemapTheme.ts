import { useEffect, useRef } from "react"
import type * as maplibregl from "maplibre-gl"
import { useTheme } from "next-themes"
import { env } from "@/lib/env"
import { useMap } from "./MapProvider"

// Basemap per theme: light and dark styles from .env.local. On a theme switch
// the style is swapped in place and every source and layer the app added
// (footprints, quicklook drape) is carried over, so results stay on the map.

function basemapFor(theme: string | undefined): string {
  return theme === "light" ? env.basemapUrl : env.basemapDarkUrl
}

// Theme at map creation. next-themes sets data-theme on <html> before the page
// hydrates, so this is right on the first frame. The theme tokens treat
// anything but "light" as dark.
export function initialBasemap(): string {
  return basemapFor(document.documentElement.dataset.theme)
}

// Sources that came with the basemap style itself. On the first switch that is
// the fetched style JSON (runtime addSource calls are not in it); after that,
// the incoming style's own sources, recorded before the app's are merged in.
// After a swap, stylesheet includes the carried-over app sources, so it cannot
// be read again.
function basemapSources(map: maplibregl.Map): Set<string> {
  return new Set(Object.keys(map.style.stylesheet?.sources ?? {}))
}

export function useBasemapTheme() {
  const { map } = useMap()
  const { resolvedTheme } = useTheme()
  const current = useRef<string | null>(null)
  const base = useRef<Set<string> | null>(null)

  useEffect(() => {
    if (!map || !resolvedTheme) return
    current.current ??= initialBasemap()
    const next = basemapFor(resolvedTheme)
    if (next === current.current) return
    current.current = next

    const oldBase = base.current ?? basemapSources(map)
    map.setStyle(next, {
      transformStyle: (previous, incoming) => {
        base.current = new Set(Object.keys(incoming.sources))
        if (!previous) return incoming
        const appSources = Object.fromEntries(
          Object.entries(previous.sources).filter(([id]) => !oldBase.has(id)),
        )
        const appLayers = previous.layers.filter(
          (layer): layer is maplibregl.LayerSpecification & { source: string } =>
            "source" in layer && typeof layer.source === "string" && !oldBase.has(layer.source),
        )
        return {
          ...incoming,
          sources: { ...incoming.sources, ...appSources },
          layers: [...incoming.layers, ...appLayers],
        }
      },
    })
  }, [map, resolvedTheme])
}
