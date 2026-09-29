"use client"
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, type ReactNode } from "react";
import { useMap } from "./MapProvider"
import { useSceneLayer } from "./useSceneLayer"
import { useQuicklookLayer } from "./useQuicklookLayer"
import { initialBasemap, useBasemapTheme } from "./useBasemapTheme"
import { AttributionControl, imageryCredits } from "./attribution"
import { useChatStore, visibleScenes } from "@/features/chat/store"
import { parseSceneDate } from "@/features/timeline/aggregate"
import { useAoiLayer } from "@/features/aoi/useAoiLayer"
import { useAoiInteraction } from "@/features/aoi/useAoiInteraction"

// Keeps the foreign providers' credits in step with the scenes on the map:
// the chosen ones while any are chosen, else every scene the filters show.
function useImageryCredits(control: React.RefObject<AttributionControl | null>) {
    const scenes = useChatStore((s) => s.scenes)
    const timeRange = useChatStore((s) => s.timeRange)
    const satelliteFilter = useChatStore((s) => s.satelliteFilter)
    const chosenIds = useChatStore((s) => s.chosenIds)
    useEffect(() => {
        const chosen = new Set(chosenIds)
        const onMap = chosen.size ? scenes.filter((s) => chosen.has(s.id)) : visibleScenes(scenes, timeRange, satelliteFilter)
        const credits = imageryCredits(
            onMap.map((s) => {
                const ms = parseSceneDate(s.date_of_pass)
                return { collection: s.collection, year: ms === null ? null : new Date(ms).getUTCFullYear() }
            }),
        )
        control.current?.setImagery(credits)
    }, [control, scenes, timeRange, satelliteFilter, chosenIds])
}

export function MapCanvas({ children }: { children?: ReactNode }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const { setMap } = useMap()
    const attribution = useRef<AttributionControl | null>(null)
    useSceneLayer()
    useQuicklookLayer()
    // After the scene layer, so the area is added above the footprints.
    useAoiLayer()
    useAoiInteraction()
    useBasemapTheme()
    useEffect(() => {
        if (!containerRef.current) return
        maplibregl.setWorkerUrl(`https://cdn.jsdelivr.net/npm/maplibre-gl@${maplibregl.getVersion()}/dist/maplibre-gl-worker.mjs`)
        const map = new maplibregl.Map({
            container: containerRef.current,
            style: initialBasemap(),
            center: [77.66, 27.5],
            zoom: 11,
            // Replaced by the explorer's own attribution control below.
            attributionControl: false,
        })
        attribution.current = new AttributionControl()
        map.addControl(attribution.current, "bottom-left")
        // Publish the map only once the style is in, so hooks that add sources
        // and layers can run immediately. map.isStyleLoaded() is not usable for
        // that: it also waits on every visible tile.
        map.once("load", () => {
            // Shift+drag draws an area instead (features/aoi).
            map.boxZoom.disable()
            setMap(map)
        })
        return () => {
            map.remove()
            setMap(null)
        }
    }, [setMap])
    // After the effect above, so the control exists when this first runs.
    useImageryCredits(attribution)
    return (
        <div className="relative h-screen w-screen overflow-hidden">
            <div ref={containerRef} className="h-full w-full"/>
            {children}
        </div>
    )
}
