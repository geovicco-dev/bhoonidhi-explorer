# Changelog

## [Unreleased]

### Added

- The scene card's "STAC Item" button opens the scene's item from the STAC
  API in a new tab. `STAC_PUBLIC_URL` names the STAC API's address for
  visitors' browsers when `STAC_API_URL` is one only the explorer reaches;
  empty, the link uses `STAC_API_URL`.

### Changed

- The scene card's "Zoom to scene" button reads "Zoom", with the full name
  in its tooltip, so the four buttons fit on one line.
- Below 1024px wide the legend is one line under the palette bar, or under
  the open palette: the four colours and their names. The palette no
  longer covers it. From 1024px up the legend panel is unchanged.
- The map credits wrap before they reach the map buttons. Below 1280px an
  open scene card sits just above the map buttons or the open credits, so
  it no longer covers them; from 1280px up it stays at the bottom.

### Fixed

- Zoom to scene, the zoom when a scene card appears, and Zoom to area wait
  until the floating panels stop moving, so the scene or area is framed in
  the space they leave. A panel still opening or shrinking was measured
  half way and could leave the footprint behind it.

## [0.1.0] - 2026-09-29

The first public release.

### Added

- The explorer: ask for scenes in plain words or fill in a query, see
  footprints and quicklooks on a map, pick scenes, and copy the `bhd`
  commands or an MCP prompt that download them. Saved sessions, place search,
  areas drawn on the map, the archive browser, GeoJSON export of footprints.
- `deploy/compose.yaml`: the explorer in one container, reading the public
  Bhoonidhi STAC API by default (`STAC_API_URL`).
- Model settings for any OpenAI-compatible server: `OPENAI_BASE_URL`,
  `OPENAI_API_KEY`, `OPENAI_MODEL`.
- A line for the model: `MODEL_SLOTS` questions are answered at once, up to
  `MODEL_QUEUE_MAX` more wait for up to `MODEL_QUEUE_WAIT_S` seconds, and the
  page shows each visitor their place and the expected wait. While a question
  waits, the page offers the query form filled in from it; running that query
  replaces the question and needs no model.
- Sessions are deleted after `CONVERSATION_RETENTION_DAYS` days without use
  (7; 0 keeps them), and the page says so under Recent.
- Per-visitor limits that work behind a reverse proxy: `CLIENT_IP_HEADER`
  and `FORWARDED_ALLOW_IPS` (see "Behind a reverse proxy" in
  `docs/self-hosting.md`).
