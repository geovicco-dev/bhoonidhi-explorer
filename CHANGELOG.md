# Changelog

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
