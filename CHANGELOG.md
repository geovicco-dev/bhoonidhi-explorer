# Changelog

## [Unreleased]

### Security

- The API's certificate bundle, certifi, moves from 2026.7.22 to
  2026.10.23. That release removes three emSign root certificates
  (emSign ECC Root CA - G3, emSign Root CA - C1 and emSign ECC Root
  CA - C3), its fix for the advisory about compromised emSign
  intermediate CA keys. The API checks its own HTTPS requests against
  this bundle: the STAC API, the place search and the quicklook images.
  The Anthropic client checks against the image's system certificates
  instead.
- Next.js moves from 16.3.6 to 16.4.6, past the advisories published for
  16.3, among them remote code execution in `use cache` functions and in
  the image optimizer. The image serves the static export and runs no
  Next.js server, so none of them reached the live site.
- The lockfile resolves the build and lint tools' dependencies to
  versions without known advisories: undici, systeminformation, zod,
  source-map-js, fast-uri and ip-address. The shadcn CLI moves to 4.23.0
  inside its range, which drops the old MCP SDK and the Express server it
  pulled in, with proxy-addr, body-parser, qs, hono and
  @hono/node-server. None of these is in the image.

## [0.3.0] - 2026-11-12

### Added

- The chat can answer with Claude through Anthropic's API
  (`MODEL_PROVIDER=anthropic`). The model, how hard it works on each step,
  whether it thinks first, how much one step may write and how long the
  start of each request stays cached are settings (`ANTHROPIC_*`). Any
  OpenAI-compatible server works as before and stays the default.
- `MODEL_FALLBACK` names a second model that answers by itself when the
  first one fails: no connection, overloaded, rate limited, out of credit,
  a refused key, or a budget reached. A failure halfway through an answer
  carries on with the fallback, and the visitor sees no error.
- Spend ceilings per UTC day and calendar month (`MODEL_BUDGET_DAILY_USD`,
  `MODEL_BUDGET_MONTHLY_USD`), counted from each answer's tokens and kept
  across restarts. Past one, the fallback answers until the day or month
  ends.
- Each answer writes one `model_usage` log line with the model, its steps,
  the tokens and the cost, and `/api/health` shows which model answers now
  and why.
- `MODEL_HISTORY_TURNS` sends only the last few turns of a long
  conversation whole, and the older ones as just the question and the
  answer. By default every turn is sent whole, as before.

### Changed

- When a chat search finds more scenes than the 1,000 it shows, the agent
  is also told the date of the oldest matching scene, so a question such as
  "how far back do LISS-3 scenes over Punjab go" gets the archive's real
  start date.
- When no model can answer, the chat shows one plain message pointing to
  the query form, instead of the model server's error text.
- `OPENAI_BASE_URL` and `OPENAI_MODEL` are needed only when an
  OpenAI-compatible server answers. A setting the chosen model needs and
  lacks stops the server at start with its name, where Compose stopped
  before.

## [0.2.1] - 2026-10-05

### Fixed

- A question or query with a resolution limit and no satellite named, such
  as "finer than 5 m" anywhere since 2000, answers in under a second
  instead of failing after a minute. The search now leaves out every
  satellite whose finest resolution is coarser than the limit, as the
  query form's "left out" note already said.

## [0.2.0] - 2026-10-03

### Added

- The scene card's "STAC Item" button opens the scene's item from the STAC
  API in a new tab. `STAC_PUBLIC_URL` names the STAC API's address for
  visitors' browsers when `STAC_API_URL` is one only the explorer reaches;
  empty, the link uses `STAC_API_URL`.
- A GitHub button in the top-right corner of the map, level with the
  palette bar, opens the explorer's source code on GitHub in a new tab. On
  narrow screens the palette bar leaves room for it on the same row.

### Changed

- The scene card's "Zoom to scene" button reads "Zoom", with the full name
  in its tooltip, so the four buttons fit on one line.
- The command palette has a dim halo in the accent, the GitHub button's
  halo at about half strength, so the two match along the top of the map.
- The CLI and MCP copy buttons are offered only for Ready scenes. On the
  scene card they are disabled for an Archived, On order or Priced scene,
  and their tooltip says how to get it from the Bhoonidhi portal. For
  several selected scenes, the copied commands and prompt download only the
  Ready ones, and the tooltip counts the others.
- Below 1024px wide the legend is one line under the palette bar, or under
  the open palette: the four colours and their names. The palette no
  longer covers it. From 1024px up the legend panel is unchanged.
- The map credits wrap before they reach the map buttons. Below 1280px an
  open scene card sits just above the map buttons or the open credits, so
  it no longer covers them; from 1280px up it stays at the bottom.
- Below 1024px the map credits fold to their "i" button five seconds after
  the map loads. A press on the "i" brings them back.

### Fixed

- Zoom to scene, the zoom when a scene card appears, and Zoom to area wait
  until the floating panels stop moving, so the scene or area is framed in
  the space they leave. A panel still opening or shrinking was measured
  half way and could leave the footprint behind it.
- On a phone the query form fits inside the palette: below 480px each
  label sits above its field, so the form no longer scrolls sideways and
  its rows keep their right margin. The palette's key hints move to a
  second line when they do not fit.
- A question that names this year ("Sentinel-2 in 2026") and is turned
  into a query in the form ends its dates on today's date in India, as the
  model's own searches do. For the first 5½ hours after midnight in India
  it ended them on the day before.

### Security

- The lockfile resolves the build and lint tools' dependencies, and those
  of Next.js, to versions without known security advisories:
  brace-expansion, browserslist, js-yaml, nanoid, postcss, undici,
  baseline-browser-mapping, fast-uri, hono and ip-address. None of them
  is in the image the site runs.

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
