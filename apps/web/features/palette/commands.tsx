"use client"

import { useEffect } from "react"
import { useTheme } from "next-themes"
import {
  IconFilter,
  IconHistory,
  IconKeyboard,
  IconMessagePlus,
  IconFocus2,
  IconMinus,
  IconMoon,
  IconPlus,
  IconStack2,
  IconSun,
  IconX,
} from "@tabler/icons-react"
import { useMap } from "@/features/map/MapProvider"
import { useChatStore } from "@/features/chat/store"
import { conversationPage, conversationRootItems } from "@/features/chat/palette"
import { areaRootItems } from "@/features/aoi/palette"
import { useAoiStore } from "@/features/aoi/store"
import { openArchive, openQueryForm } from "@/features/query/open"
import type { PaletteItem, PalettePage } from "./types"

// The keyboard shortcuts page (> Keyboard shortcuts): the keys that run an
// action. How to use the palette and the map (Enter, arrows, clicks) is left
// to the footer and the tooltips.
const SHORTCUTS_PAGE = "shortcuts"

const SHORTCUTS: { section: string; keys: [string, string][] }[] = [
  {
    section: "Palette",
    keys: [
      ["Ctrl K", "Open or close the palette"],
      [">", "Commands"],
      ["@", "Search for a place"],
      ["?", "Query the catalogue"],
      ["\\a", "Browse the archive"],
      ["\\n", "New session"],
      ["[", "Session tab"],
      ["]", "Scenes tab"],
    ],
  },
  {
    section: "Map",
    keys: [
      ["R", "Draw a rectangle"],
      ["P", "Draw from a point"],
      ["O", "Hide or show the quicklook"],
      ["D", "Light or dark theme"],
      ["Ctrl Z", "Undo the area"],
      ["Ctrl ⇧ Z", "Redo the area"],
    ],
  },
]

function shortcutsPage(): PalettePage {
  return {
    id: SHORTCUTS_PAGE,
    title: "Keyboard shortcuts",
    placeholder: "Filter shortcuts…",
    items: SHORTCUTS.flatMap(({ section, keys }) =>
      keys.map(([key, what]) => ({ id: `key:${section}:${key}`, label: what, keywords: key, hint: key, section })),
    ),
  }
}

// Every command the palette offers (after ">"), gathered from the features that
// own them. A new feature adds its rows here (or a builder like
// conversationRootItems); the palette itself stays generic. `openPlaces`
// switches the bar to place search, which the palette owns.
export function useCommands(
  open: boolean,
  openPlaces: () => void,
): {
  root: PaletteItem[]
  resolvePage: (id: string) => PalettePage | null
} {
  const { map } = useMap()
  const { resolvedTheme, setTheme } = useTheme()
  const hasArea = useAoiStore((s) => !!s.aoi)
  const streaming = useChatStore((s) => s.streaming)
  const conversations = useChatStore((s) => s.conversations)
  const conversationId = useChatStore((s) => s.conversationId)
  const newConversation = useChatStore((s) => s.newConversation)
  const openConversation = useChatStore((s) => s.open)
  const renameConversation = useChatStore((s) => s.rename)
  const forkConversation = useChatStore((s) => s.fork)
  const removeConversation = useChatStore((s) => s.remove)
  const refreshConversations = useChatStore((s) => s.refreshList)
  const selectedSceneId = useChatStore((s) => s.selectedSceneId)
  const closeScene = useChatStore((s) => s.closeScene)
  const requestZoom = useChatStore((s) => s.requestZoom)

  // The conversation list can change from another browser tab; refresh on open.
  useEffect(() => {
    if (open) void refreshConversations()
  }, [open, refreshConversations])

  const conversationActions = {
    currentId: conversationId,
    streaming,
    open: (id: string) => void openConversation(id),
    newConversation,
    rename: (id: string, title: string) => void renameConversation(id, title),
    fork: (id: string) => void forkConversation(id),
    remove: (id: string) => void removeConversation(id),
  }

  const root: PaletteItem[] = [
    ...conversationRootItems(conversations, conversationActions).map((item) => ({
      ...item,
      icon: item.id === "conv:new" ? <IconMessagePlus size={16} /> : <IconHistory size={16} />,
    })),

    ...areaRootItems(hasArea, openPlaces),

    // Search
    {
      id: "query:open",
      label: "Query the catalogue",
      detail: "Pick satellites, products, dates and filters in a form",
      keywords: "query search form filter stac browser structured",
      icon: <IconFilter size={16} />,
      hint: "?",
      section: "Search",
      run: openQueryForm,
    },
    {
      id: "archive:open",
      label: "Browse the archive",
      detail: "Every satellite and sensor, when it ran, its resolution and access",
      keywords: "archive satellites sensors products catalogue list browse",
      icon: <IconStack2 size={16} />,
      hint: "\\a",
      section: "Search",
      run: openArchive,
    },

    // Results
    {
      id: "scene:zoom",
      label: "Zoom to selected scene",
      keywords: "fit footprint camera",
      icon: <IconFocus2 size={16} />,
      section: "Results",
      disabled: !selectedSceneId,
      run: requestZoom,
    },
    {
      id: "scene:deselect",
      label: "Close scene details",
      keywords: "deselect clear selection",
      icon: <IconX size={16} />,
      section: "Results",
      disabled: !selectedSceneId,
      run: closeScene,
    },

    // Map
    {
      id: "map:zoom-in",
      label: "Zoom in",
      icon: <IconPlus size={16} />,
      section: "Map",
      run: () => map?.zoomIn(),
    },
    {
      id: "map:zoom-out",
      label: "Zoom out",
      icon: <IconMinus size={16} />,
      section: "Map",
      run: () => map?.zoomOut(),
    },

    // Appearance
    {
      id: "theme:toggle",
      label: resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      keywords: "theme dark light mode appearance",
      icon: resolvedTheme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />,
      hint: "D",
      section: "Appearance",
      run: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
    },

    // Help
    {
      id: "help:shortcuts",
      label: "Keyboard shortcuts",
      keywords: "keys keybindings hotkeys help",
      icon: <IconKeyboard size={16} />,
      section: "Help",
      pageId: SHORTCUTS_PAGE,
    },
  ]

  const resolvePage = (id: string) =>
    id === SHORTCUTS_PAGE ? shortcutsPage() : conversationPage(id, conversations, conversationActions)

  return { root, resolvePage }
}
