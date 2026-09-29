"use client"

// A scene in the strip: its quicklook fills the card and the date sits on it,
// bottom left, over a dark fade. Over a pure white quicklook the date still
// reads at 5.4:1 at the top of its letters, where the fade is weakest, in
// either theme. The satellite and product are in the screen-reader label and
// the scene's detail card.

type Props = {
  date: string
  // What a screen reader announces: the product and the date.
  label: string
  thumbnailSrc?: string
  // Chosen along with others; the open scene shows as the wide card instead.
  chosen?: boolean
  onClick: (e: React.MouseEvent) => void
}

const FADE =
  "linear-gradient(to top, color-mix(in srgb, var(--bx-slate-950) 85%, transparent), color-mix(in srgb, var(--bx-slate-950) 60%, transparent) 35%, transparent)"

export function SceneCard({ date, label, thumbnailSrc, chosen, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`group relative block h-32 w-44 shrink-0 overflow-hidden rounded-xl border ${chosen ? "border-action ring-2 ring-action/40" : "border-border-default hover:border-border-strong"} bg-surface-inset text-left shadow transition-[translate,border-color,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0`}
    >
      {thumbnailSrc && (
        <span
          aria-hidden
          className="absolute inset-0 bg-cover bg-center transition-transform duration-300 group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
          style={{ backgroundImage: `url(${JSON.stringify(thumbnailSrc)})` }}
        />
      )}
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-3/5" style={{ backgroundImage: FADE }} />
      <span
        aria-hidden
        className="absolute bottom-1.5 left-2 font-mono text-[11px] leading-4 font-medium tracking-[0.01em]"
        style={{ color: "var(--bx-slate-50)", textShadow: "0 1px 2px rgb(0 0 0 / 0.5)" }}
      >
        {date}
      </span>
    </button>
  )
}
