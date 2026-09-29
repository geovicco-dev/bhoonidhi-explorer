"use client"

import type { HTMLAttributes, ReactNode } from "react"
import { Tooltip } from "@base-ui/react/tooltip"
import { cn } from "@workspace/ui/lib/utils"

// The map's tool rail: buttons in a floating panel, horizontal or vertical.
// It holds the tooltip provider, so each ToolButton's tooltip needs no setup.
export function Toolbar({
  className,
  orientation = "horizontal",
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }) {
  return (
    <Tooltip.Provider>
      <div
        role="toolbar"
        aria-orientation={orientation}
        className={cn(
          "bx-surface flex items-center gap-1 rounded-xl p-1 text-fg shadow-lg",
          orientation === "vertical" ? "flex-col" : "flex-row",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </Tooltip.Provider>
  )
}

type ToolButtonProps = Omit<HTMLAttributes<HTMLButtonElement>, "title"> & {
  icon: ReactNode
  // Accessible name; also the tooltip unless `tooltip` is given.
  label: string
  tooltip?: ReactNode
  // The tool is the current one (drawn in the accent).
  active?: boolean
  // Shown as a key in the tooltip.
  shortcut?: string
  disabled?: boolean
}

export function ToolButton({
  className,
  icon,
  label,
  tooltip,
  active = false,
  shortcut,
  disabled,
  ...props
}: ToolButtonProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={active}
            disabled={disabled}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-inset hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring disabled:pointer-events-none disabled:opacity-50",
              active && "bg-action text-on-action hover:bg-action-hover hover:text-on-action",
              className,
            )}
            {...props}
          >
            {icon}
          </button>
        }
      />
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup className="flex items-center gap-2 rounded-md border border-border-strong bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg">
            <span>{tooltip ?? label}</span>
            {shortcut ? (
              <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-border-default bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">
                {shortcut}
              </kbd>
            ) : null}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
