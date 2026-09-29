"use client"
import { createContext, useContext, useMemo, useState, type ReactNode } from "react"
import type * as maplibregl from "maplibre-gl"
// The live map (null until MapCanvas creates it) and the setter MapCanvas
// uses to publish it.
type MapContextValue = {
  map: maplibregl.Map | null
  setMap: (map: maplibregl.Map | null) => void
}
const MapContext = createContext<MapContextValue | null>(null)
export function MapProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<maplibregl.Map | null>(null)
  // Memoized so consumers re-render only when the map changes; setMap is a
  // useState setter and already stable.
  const value = useMemo(() => ({ map, setMap }), [map])
  return (
    <MapContext.Provider value={value}>
      {children}
    </MapContext.Provider>
  )
}
// The map context. Throws outside <MapProvider>, where the map would never
// arrive.
export function useMap() {
  const ctx = useContext(MapContext)
  if (!ctx) throw new Error("useMap must be used inside <MapProvider>")
  return ctx
}