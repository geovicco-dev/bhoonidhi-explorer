import {
  IconCirclePlus,
  IconClock,
  IconCurrentLocation,
  IconFocusCentered,
  IconMapPin,
  IconMapPinSearch,
  IconPencil,
  IconSquareDashed,
  IconTrash,
} from "@tabler/icons-react"
import type { Place } from "@/features/chat/stream"
import { dismissPalette } from "@/features/palette/store"
import type { PaletteItem } from "@/features/palette/types"
import { coordsPlace, parseCoords, usePlaceStore } from "./places"
import { useAoiStore } from "./store"
import { armTool } from "./useAoiShortcuts"

// Palette rows for the area of interest: the Area commands (after ">") and
// the place-search rows (after "@").

function pickPlace(place: Place, asBox: boolean) {
  usePlaceStore.getState().choose(place, asBox)
  dismissPalette()
}

function placeItem(place: Place, id: string, icon: React.ReactNode): PaletteItem {
  return {
    id,
    label: place.name,
    detail: place.detail && place.detail !== place.name ? place.detail : undefined,
    hint: place.kind ?? undefined,
    icon,
    run: () => pickPlace(place, false),
    altRun: () => pickPlace(place, true),
  }
}

type PlaceSearch = {
  searched: string
  results: Place[]
  status: "idle" | "loading" | "done" | "error"
  error: string | null
  recent: Place[]
}

// What the list shows for the text after "@": recent places while empty, one
// row for coordinates, the search results for the text once searched, or a
// line saying what Enter will do.
export function placeRows(
  text: string,
  s: PlaceSearch,
): { items: PaletteItem[]; message: string | null; canSearch: boolean } {
  if (!text) {
    return {
      items: s.recent.map((p, i) => placeItem(p, `recent:${i}`, <IconClock size={16} />)),
      message: s.recent.length ? null : "Type a place name and press Enter. Coordinates work too: 25.58, 91.89",
      canSearch: false,
    }
  }
  const coords = parseCoords(text)
  if (coords) {
    const place = coordsPlace(coords.lat, coords.lon)
    return {
      items: [{ ...placeItem(place, "coords", <IconCurrentLocation size={16} />), label: `Go to ${place.name}` }],
      message: null,
      canSearch: false,
    }
  }
  if (s.searched === text) {
    if (s.status === "loading") return { items: [], message: "Searching…", canSearch: false }
    if (s.status === "error") return { items: [], message: `Place search failed: ${s.error}`, canSearch: true }
    if (s.status === "done") {
      return {
        items: s.results.map((p, i) => placeItem(p, `place:${i}`, <IconMapPin size={16} />)),
        message: s.results.length ? null : `No places found for “${text}”.`,
        canSearch: false,
      }
    }
  }
  return {
    items: [],
    message: text.length < 2 ? "Keep typing a place name…" : `Press Enter to search for “${text}”.`,
    canSearch: text.length >= 2,
  }
}

// The Area section of the command list.
export function areaRootItems(hasArea: boolean, openPlaces: () => void): PaletteItem[] {
  return [
    {
      id: "aoi:rectangle",
      label: "Draw a rectangle",
      keywords: "area aoi bbox box extent square draw",
      hint: "R",
      icon: <IconSquareDashed size={16} />,
      section: "Area",
      run: () => armTool("rectangle"),
    },
    {
      id: "aoi:point",
      label: "Draw from a point",
      keywords: "area aoi point circle radius buffer centre center draw",
      detail: "Click the centre, then the edge",
      hint: "P",
      icon: <IconCirclePlus size={16} />,
      section: "Area",
      run: () => armTool("point"),
    },
    {
      id: "aoi:place",
      label: "Go to a place",
      keywords: "search find geocode location city town fly",
      hint: "@",
      icon: <IconMapPinSearch size={16} />,
      section: "Area",
      run: openPlaces,
    },
    {
      id: "aoi:zoom",
      label: "Zoom to area",
      keywords: "fit area aoi camera",
      icon: <IconFocusCentered size={16} />,
      section: "Area",
      disabled: !hasArea,
      run: () => {
        dismissPalette()
        useAoiStore.getState().flyTo()
      },
    },
    {
      id: "aoi:edit",
      label: "Edit area",
      keywords: "resize move coordinates numbers aoi",
      icon: <IconPencil size={16} />,
      section: "Area",
      disabled: !hasArea,
      run: () => {
        dismissPalette()
        useAoiStore.getState().setEditing(true, true)
      },
    },
    {
      id: "aoi:delete",
      label: "Delete area",
      keywords: "remove clear aoi",
      detail: "Ctrl+Z brings it back",
      icon: <IconTrash size={16} />,
      section: "Area",
      disabled: !hasArea,
      run: () => useAoiStore.getState().commit(null),
    },
  ]
}
