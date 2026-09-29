"use client"
import { ToolButton } from "@workspace/ui/components/toolbar"
import { IconCirclePlus, IconMarquee2, IconSquareDashed } from "@tabler/icons-react"
import { useAoiStore } from "./store"
import { armTool, toggleDraw } from "./useAoiShortcuts"
import type { DrawTool } from "./types"

// The one draw button in the map toolbar. Idle it shows the marquee; armed, it
// shows the armed mode's icon, highlighted. A click arms the last-used mode
// (rectangle at first), or disarms. A double-click switches to the other mode
// and leaves it armed, so the icon shows which mode is now in use.

// How each mode reads in the label and tooltip: "Draw a rectangle", "Drawing
// from a point".
const MODES: Record<DrawTool, { name: string; draw: string; drawing: string; icon: React.ReactNode; shortcut: string }> = {
  rectangle: {
    name: "rectangle",
    draw: "draw a rectangle",
    drawing: "Drawing a rectangle",
    icon: <IconSquareDashed size={18} />,
    shortcut: "R",
  },
  point: {
    name: "from a point",
    draw: "draw from a point",
    drawing: "Drawing from a point",
    icon: <IconCirclePlus size={18} />,
    shortcut: "P",
  },
}

const other = (tool: DrawTool): DrawTool => (tool === "rectangle" ? "point" : "rectangle")

export function DrawButton() {
  const tool = useAoiStore((s) => s.tool)
  const mode = useAoiStore((s) => s.mode)
  const current = MODES[mode]
  const next = MODES[other(mode)]
  const armed = tool ? MODES[tool] : null

  return (
    <ToolButton
      className="size-6"
      icon={armed ? armed.icon : <IconMarquee2 size={18} />}
      label={armed ? `Drawing: ${armed.name}. Stop drawing` : `Draw an area: ${current.name}`}
      // The tooltip is where a new user learns the switch.
      tooltip={
        armed
          ? `${armed.drawing}. Click to stop, double-click to ${next.draw}`
          : `Click to ${current.draw}, double-click to ${next.draw}`
      }
      shortcut={armed ? "Esc" : current.shortcut}
      active={!!armed}
      onClick={(e) => {
        // A double-click arrives as two clicks. The first toggles drawing as a
        // single click does; the second (detail 2) arms the other mode. The
        // mode read then is the one the first click used, whether it armed or
        // disarmed. Enter and Space give detail 0 and only toggle.
        if (e.detail === 2) armTool(other(useAoiStore.getState().mode))
        else if (e.detail <= 1) toggleDraw()
      }}
    />
  )
}
