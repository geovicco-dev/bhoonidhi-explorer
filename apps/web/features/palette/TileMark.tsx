"use client"

// The palette's mark: a 3x3 grid of map tiles. Still while idle; while
// `busy`, the cells fade in a diagonal wave (bx-tile-cell in tokens.css), so
// the mark doubles as the spinner.
// Coloured with the explorer's accent (sky blue), the same as the send button.

// Diagonal stagger, top-left to bottom-right.
const DELAYS = [0, 120, 240, 120, 240, 360, 240, 360, 480]

export function TileMark({ busy = false }: { busy?: boolean }) {
  return (
    <span
      role={busy ? "status" : undefined}
      aria-label={busy ? "Working" : undefined}
      aria-hidden={busy ? undefined : true}
      className="inline-block size-4 shrink-0 text-action motion-reduce:[&_rect]:animate-none"
    >
      <svg viewBox="0 0 30 30" width="100%" height="100%" aria-hidden>
        {DELAYS.map((delay, i) => (
          <rect
            key={i}
            x={(i % 3) * 10 + 1}
            y={Math.floor(i / 3) * 10 + 1}
            width={8}
            height={8}
            rx={1.5}
            fill="currentColor"
            className={busy ? "bx-tile-cell" : undefined}
            style={busy ? { animationDelay: `${delay}ms` } : undefined}
          />
        ))}
      </svg>
    </span>
  )
}
