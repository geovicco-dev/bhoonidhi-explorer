import { IconBrandGithub } from "@tabler/icons-react"

const SOURCE_CODE = "https://github.com/geovicco-dev/bhoonidhi-explorer"

// The explorer's source code on GitHub, a rounded-square button in the
// top-right corner with a soft halo in the accent (.bx-halo-link in
// globals.css). As tall as the palette bar and level with it; on narrow
// screens the palette bar leaves room for it on the same row.
export function GitHubLink() {
  return (
    <a
      href={SOURCE_CODE}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Source code on GitHub"
      title="Source code on GitHub"
      data-map-inset="top"
      className="bx-halo-link pointer-events-auto flex shrink-0"
    >
      <IconBrandGithub size={21} stroke={1.75} />
    </a>
  )
}
