import type * as maplibregl from "maplibre-gl"

const link = (href: string, text: string) =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`

// Credit for the imagery (linked to the Bhoonidhi EULA) and the explorer.
const ISRO = link("https://bhoonidhi.nrsc.gov.in/bhoonidhi/htmls/TnC.html", "© ISRO-IRS")
const AUTHOR = link("https://github.com/geovicco-dev", "© Aditya Sharma")

// The credit each foreign provider asks for, by the start of the catalogue's
// collection id. Copernicus and EUMETSAT prescribe their wording with the
// year of the data; USGS, NASA and NOAA ask that the source be named.
const PROVIDERS: { prefixes: string[]; credit: (years: string) => string }[] = [
  { prefixes: ["sentinel-"], credit: (y) => `Copernicus Sentinel data ${y}` },
  { prefixes: ["metop-"], credit: (y) => `EUMETSAT Metop data ${y}` },
  { prefixes: ["landsat-"], credit: () => "Landsat: USGS" },
  { prefixes: ["suomi-npp-", "jpss"], credit: () => "VIIRS: NASA/NOAA" },
  { prefixes: ["nisar-"], credit: () => "NISAR: NASA/ISRO" },
]

// The foreign credits for the scenes on the map, in a fixed order.
export function imageryCredits(scenes: { collection?: string; year: number | null }[]): string[] {
  return PROVIDERS.flatMap(({ prefixes, credit }) => {
    const mine = scenes.filter((s) => prefixes.some((p) => s.collection?.startsWith(p)))
    if (!mine.length) return []
    const years = mine.map((s) => s.year).filter((y): y is number => y !== null)
    const from = Math.min(...years)
    const to = Math.max(...years)
    return [credit(!years.length ? "" : from === to ? `${from}` : `${from}–${to}`).trim()]
  })
}

// The map's one attribution: the basemap's credits first, then ISRO's, the
// foreign providers' for the scenes on the map, and the author's.
// MapLibre's own control sorts all credits by length, so their order would
// change with the basemap. This one uses MapLibre's classes and its compact
// behaviour: open on load, collapsed to the "i" button on the first pan (as
// OpenStreetMap's attribution guidelines allow), and the "i" toggles it.
// Below 1024px it also folds by itself five seconds after the map loads,
// which the same guidelines allow; a press on the "i" before then cancels it.
const FOLD_BY_ITSELF = "(max-width: 1023.98px)"
const FOLD_AFTER_MS = 5000

export class AttributionControl implements maplibregl.IControl {
  private map: maplibregl.Map | null = null
  private readonly container = document.createElement("div")
  private readonly inner = document.createElement("div")
  private html = ""
  private imagery: string[] = []
  private foldTimer: number | undefined

  // The foreign providers' credits; plain text, so escaped before use.
  setImagery(credits: string[]) {
    this.imagery = credits.map((c) => c.replaceAll("&", "&amp;").replaceAll("<", "&lt;"))
    this.update()
  }

  onAdd(map: maplibregl.Map) {
    this.map = map
    this.container.className =
      "maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show"
    // The selected-scene card keeps clear of it (SelectedSceneCard).
    this.container.dataset.bottomChrome = ""
    const button = document.createElement("button")
    button.type = "button"
    button.className = "maplibregl-ctrl-attrib-button"
    button.title = "Toggle attribution"
    button.setAttribute("aria-label", "Toggle attribution")
    button.addEventListener("click", this.toggle)
    this.inner.className = "maplibregl-ctrl-attrib-inner"
    this.container.append(button, this.inner)
    map.on("styledata", this.update)
    map.on("sourcedata", this.onSourceData)
    map.on("drag", this.collapse)
    // From the load, when the basemap's credits are in, so they show for the
    // full five seconds.
    map.once("load", this.startFoldTimer)
    this.update()
    return this.container
  }

  onRemove() {
    window.clearTimeout(this.foldTimer)
    this.map?.off("styledata", this.update)
    this.map?.off("sourcedata", this.onSourceData)
    this.map?.off("drag", this.collapse)
    this.map?.off("load", this.startFoldTimer)
    this.container.remove()
    this.map = null
  }

  private readonly toggle = () => {
    window.clearTimeout(this.foldTimer)
    this.container.classList.toggle("maplibregl-compact-show")
  }
  private readonly collapse = () => this.container.classList.remove("maplibregl-compact-show")
  private readonly startFoldTimer = () => {
    this.foldTimer = window.setTimeout(() => {
      if (window.matchMedia(FOLD_BY_ITSELF).matches) this.collapse()
    }, FOLD_AFTER_MS)
  }

  // A source's credit arrives with its metadata; tile loads change nothing.
  private readonly onSourceData = (e: maplibregl.MapSourceDataEvent) => {
    if (e.sourceDataType === "metadata") this.update()
  }

  private readonly update = () => {
    const map = this.map
    const sources = map?.getStyle()?.sources
    if (!map || !sources) return
    const basemap = new Set<string>()
    for (const id of Object.keys(sources)) {
      const credit = map.getSource(id)?.attribution
      if (credit) basemap.add(credit)
    }
    const html = [...basemap, ISRO, ...this.imagery, AUTHOR].join(" | ")
    if (html === this.html) return
    this.html = html
    this.inner.replaceChildren(...clean(html))
  }
}

// Basemap credits come from third-party style and tile servers, so only text
// and http(s) links are kept; any other markup is reduced to its text.
function clean(html: string): Node[] {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const out: Node[] = []
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out.push(document.createTextNode(child.textContent ?? ""))
      } else if (child instanceof HTMLAnchorElement && /^https?:\/\//.test(child.getAttribute("href") ?? "")) {
        const a = document.createElement("a")
        a.href = child.getAttribute("href")!
        a.target = "_blank"
        a.rel = "noopener noreferrer"
        a.textContent = child.textContent
        out.push(a)
      } else {
        walk(child)
      }
    }
  }
  walk(doc.body)
  return out
}
