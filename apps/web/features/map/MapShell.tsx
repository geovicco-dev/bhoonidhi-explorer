"use client"
import dynamic from "next/dynamic"
import { MapProvider } from "@/features/map/MapProvider"
import { MapOverlay } from "@/features/overlay/MapOverlay"

const MapCanvas = dynamic(
    () => import("./MapCanvas").then((mod) => mod.MapCanvas),
    { ssr: false }
)
export function MapShell() {
    return (
        <MapProvider>
            <MapCanvas>
                <MapOverlay />   
            </MapCanvas>
        </MapProvider>
    )
}