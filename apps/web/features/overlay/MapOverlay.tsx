"use client"
import { Toolbar, ToolButton } from "@workspace/ui/components/toolbar"
import { IconPlus, IconMinus } from "@tabler/icons-react"
import { useMap } from "@/features/map/MapProvider"
import { AoiOverlay } from "@/features/aoi/AoiOverlay"
import { DrawButton } from "@/features/aoi/DrawButton"
import { useQuicklookKey } from "@/features/map/QuicklookControl"
import { AvailabilityLegend } from "@/features/scene/AvailabilityLegend"
import { CommandPalette } from "@/features/palette/CommandPalette"
import { SelectedSceneCard } from "@/features/scene/SelectedSceneCard"
import { useQueryShortcut } from "@/features/query/open"
import { GitHubLink } from "./GitHubLink"

// Chrome floating over the map canvas. The palette at the top left is the one
// control surface (questions, conversation, scenes, commands); the legend and
// the map toolbar stay as their own small panels. The area of interest draws
// its card and handles over the map, beneath the chrome.
export function MapOverlay() {
    const { map } = useMap()
    useQueryShortcut()
    useQuicklookKey()

    return (
        <div className="pointer-events-none absolute inset-0 z-10">
            <AoiOverlay />
            <CommandPalette />
            <SelectedSceneCard />

            {/* Top right: the legend (once scenes exist), then the GitHub link
                in the corner. */}
            <div className="pointer-events-none absolute right-4 top-4 z-20 flex items-start gap-3">
                <AvailabilityLegend />
                <GitHubLink />
            </div>

            <div data-bottom-chrome className="pointer-events-auto absolute bottom-2 right-2">
                <Toolbar orientation="vertical">
                    <DrawButton />
                    <ToolButton className="size-6" icon={<IconPlus size={20} />} label="Zoom In" shortcut="+" onClick={() => map?.zoomIn()} />
                    <ToolButton className="size-6" icon={<IconMinus size={20} />} label="Zoom Out" shortcut="-" onClick={() => map?.zoomOut()} />
                </Toolbar>
            </div>
        </div>
    )
}

// pointer-events-none keeps the overlay click-through so drags reach the map;
// each widget re-enables pointer events itself.
