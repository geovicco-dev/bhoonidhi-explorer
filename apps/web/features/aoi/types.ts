// The area of interest, in the two shapes the Bhoonidhi portal and `bhd`
// accept: a bounding box, or a point plus a radius. Field names match the API.

export type AoiBox = {
  kind: "bbox"
  west: number
  south: number
  east: number
  north: number
  // Set when the area came from a place (the agent's lookup or a place search).
  name?: string
}

export type AoiCircle = {
  kind: "circle"
  lon: number
  lat: number
  radius_km: number
  name?: string
}

export type Aoi = AoiBox | AoiCircle

// Rectangle: drag, or click two corners. Point: click the centre, then click
// again at the edge (a click on the centre itself drops the `bhd` default).
export type DrawTool = "rectangle" | "point"

export type AoiColor = "red" | "amber" | "sky" | "white"

export type AoiStyle = {
  color: AoiColor
  line: "dashed" | "solid"
  fill: "none" | "light"
}
