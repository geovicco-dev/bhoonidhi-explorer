import { create } from "zustand"
import {
  api,
  streamChat,
  type Conversation,
  type ConversationState,
  type ConversationSummary,
  type StoredTurn,
} from "./stream"
import type { AgentEvent, Scene, SearchResult } from "./types"
// aggregate.ts imports only types, so this is not a cycle.
import { parseSceneDate } from "@/features/timeline/aggregate"
import { areaAfter, areaFromTurns } from "@/features/aoi/agent"
import { sameAoi } from "@/features/aoi/geo"
import { useAoiStore } from "@/features/aoi/store"
import type { Aoi } from "@/features/aoi/types"
import type { Query } from "@/features/query/store"
import { isGone } from "@/lib/http"

// One item in the conversation timeline: a message or a tool-call card. Each
// carries the turn it belongs to, so editing or retrying turn N can drop it
// and everything after it.
export type TimelineItem =
  | {
      kind: "message"
      id: string
      turn: number
      role: "user" | "assistant"
      text: string
      // The area of interest a prompt was sent with.
      area?: Aoi
      // Set on a turn run from the query form: the query, for "Edit query".
      query?: Query
    }
  | {
      kind: "tool"
      id: string
      turn: number
      name: string
      status: "running" | "succeeded" | "failed"
      // "bhoonidhi" for agent tools, "map" for the client-side plot step.
      server?: string
      args?: Record<string, unknown>
      result?: unknown
    }

type ChatState = {
  // The open conversation; null until the first prompt creates one.
  conversationId: string | null
  title: string
  // The browser's conversations, newest first, for the palette and header.
  conversations: ConversationSummary[]
  // Days the server keeps a conversation after its last activity (0: for
  // ever); null until the list has loaded.
  retentionDays: number | null
  timeline: TimelineItem[]
  streaming: boolean
  // Set while the question waits in line for the model, cleared when it
  // starts: the question, its place (1 = next) and the estimated seconds.
  waiting: { text: string; position: number; wait_s: number } | null
  error: string | null
  // Latest search result's scenes; the single in-memory result layer.
  scenes: Scene[]
  // True when that search matched more than the scenes returned (the API
  // returns the newest 1,000 and does not count past them).
  moreScenes: boolean
  // [startMs, endMs] from the density timeline, or null. AND-combined with
  // satelliteFilter; out-of-range scenes are removed, not dimmed.
  timeRange: [number, number] | null
  setTimeRange: (range: [number, number] | null) => void
  // The chosen Scene.satellite codes; empty shows every satellite.
  // AND-combined with timeRange.
  satelliteFilter: string[]
  setSatelliteFilter: (sats: string[]) => void
  // Scene whose card is open and whose quicklook is draped on the map, or null.
  selectedSceneId: string | null
  // Scenes chosen in the strip, which the hand-off and exports act on. The
  // open scene is one of them.
  chosenIds: string[]
  // A plain click chooses only that scene; "toggle" (Ctrl/Cmd+click) adds or
  // removes it; "run" (Shift+click) chooses every scene from the last one
  // clicked to this one, in the order of `order` (the scenes shown).
  chooseScene: (id: string, how: "only" | "toggle" | "run", order: string[]) => void
  // Closes the open card and un-chooses its scene; the others stay chosen.
  closeScene: () => void
  clearChosen: () => void
  // A counter, not a boolean, so repeated "Zoom to scene" presses on the
  // same scene each move the camera.
  zoomRequest: number
  requestZoom: () => void
  // plot_scenes card still in flight; the map layer calls finishPlot().
  pendingPlotId: string | null
  finishPlot: () => void

  send: (text: string) => Promise<void>
  // Run a query from the form and save it as a turn; fromTurn replaces that
  // turn and everything after it. False when it did not run.
  runQuery: (query: Query, fromTurn: number | null) => Promise<boolean>
  // Edit turn N's prompt, or retry it as is: drops turn N and later, reruns.
  rerun: (turn: number, text: string) => Promise<void>
  stop: () => void
  // Takes back a question still waiting for the model, so a query can run
  // in its place: it leaves the line and the panel. Nothing while it answers.
  withdraw: () => Promise<void>
  newConversation: () => void
  refreshList: () => Promise<void>
  open: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  fork: (id: string, upto?: number) => Promise<void>
  remove: (id: string) => Promise<void>
}

// Shared by the map layer and the strip so both derive the same set.
export function visibleScenes(
  scenes: Scene[],
  timeRange: [number, number] | null,
  satellites: string[],
): Scene[] {
  return scenes.filter((s) => {
    // "Unknown" is the timeline's row for scenes without a satellite.
    if (satellites.length && !satellites.includes(s.satellite ?? "Unknown")) return false
    if (timeRange) {
      const ms = parseSceneDate(s.date_of_pass)
      // Undated scenes are never hidden by a time filter.
      if (ms !== null && (ms < timeRange[0] || ms > timeRange[1])) return false
    }
    return true
  })
}

let controller: AbortController | null = null
// The turn now streaming, so a query run while its question waits can take
// the question back and wait for it to settle.
let current: Promise<void> | null = null
// Set by withdraw() just before it stops a waiting question.
let withdrawn = false
let seq = 0
const nextId = () => `${Date.now()}-${seq++}`

function isSearchResult(r: unknown): r is SearchResult {
  return !!r && typeof r === "object" && "scenes" in r
}

// A search result's scenes, each once. A saved result can hold a scene twice
// (the catalogue files some scenes under two products), and the strip and the
// map tell scenes apart by id.
function scenesOf(result: SearchResult | null): Scene[] {
  const byId = new Map<string, Scene>()
  for (const s of result?.scenes ?? []) if (!byId.has(s.id)) byId.set(s.id, s)
  return [...byId.values()]
}

// Folds one streamed event into the timeline. Shared by live streaming and
// by replaying stored turns on resume, so both render identically.
function applyEvent(timeline: TimelineItem[], turn: number, event: AgentEvent): TimelineItem[] {
  if (event.type === "area" || event.type === "query") {
    // The area goes on the turn's prompt, for its area chip; a query too, for
    // "Edit query".
    const patch = event.type === "area" ? { area: event.area } : { query: event.query }
    return timeline.map((i) =>
      i.kind === "message" && i.role === "user" && i.turn === turn ? { ...i, ...patch } : i,
    )
  }
  if (event.type === "agent" || event.type === "answer") {
    return [...timeline, { kind: "message", id: nextId(), turn, role: "assistant", text: event.text }]
  }
  if (event.type === "tool_call") {
    return [
      ...timeline,
      {
        kind: "tool",
        id: nextId(),
        turn,
        name: event.name,
        server: "bhoonidhi",
        status: "running",
        args: event.arguments,
      },
    ]
  }
  if (event.type === "tool_result") {
    const next = [...timeline]
    for (let i = next.length - 1; i >= 0; i--) {
      const item = next[i]
      if (item && item.kind === "tool" && item.name === event.name && item.status === "running") {
        next[i] = { ...item, status: "succeeded", result: event.result }
        break
      }
    }
    return next
  }
  return timeline
}

function plotCard(turn: number, count: number, status: "running" | "succeeded"): TimelineItem {
  return {
    kind: "tool",
    id: nextId(),
    turn,
    name: "plot_scenes",
    server: "map",
    status,
    args: { scenes: count },
  }
}

// Rebuild the timeline and the latest scene set from stored turns.
function replay(turns: StoredTurn[]): { timeline: TimelineItem[]; scenes: Scene[]; moreScenes: boolean } {
  let timeline: TimelineItem[] = []
  let scenes: Scene[] = []
  let moreScenes = false
  for (const t of turns) {
    timeline.push({ kind: "message", id: nextId(), turn: t.idx, role: "user", text: t.prompt })
    let found: SearchResult | null = null
    for (const e of t.events) {
      timeline = applyEvent(timeline, t.idx, e)
      if (e.type === "tool_result" && isSearchResult(e.result)) found = e.result
    }
    // A tool call that never got a result was cut off (stopped or failed).
    timeline = timeline.map((i) =>
      i.kind === "tool" && i.turn === t.idx && i.status === "running" ? { ...i, status: "failed" } : i,
    )
    if (found) {
      scenes = scenesOf(found)
      moreScenes = !!found.more_available
      if (scenes.length) timeline.push(plotCard(t.idx, scenes.length, "succeeded"))
    }
  }
  return { timeline, scenes, moreScenes }
}

// No satellite chosen: every satellite shows. One shared empty list, so
// resetting the choice does not count as a change when it is already empty.
const ALL_SATELLITES: string[] = []

// Conversations saved before several satellites could be chosen hold one
// satellite code, or null. Codes with no scene in the results are dropped, so
// a stale choice cannot leave the tab empty with nothing marked as chosen.
function savedSatellites(saved: string[] | string | null | undefined, scenes: Scene[]): string[] {
  const codes = Array.isArray(saved) ? saved : saved ? [saved] : []
  const present = new Set(scenes.map((s) => s.satellite ?? "Unknown"))
  const kept = codes.filter((c) => present.has(c))
  return kept.length ? kept : ALL_SATELLITES
}

const NONE_CHOSEN: string[] = []

const emptyResults = {
  scenes: [] as Scene[],
  moreScenes: false,
  timeRange: null,
  satelliteFilter: ALL_SATELLITES,
  selectedSceneId: null,
  chosenIds: NONE_CHOSEN,
  pendingPlotId: null,
}

// Where a Shift+click run starts: the scene last clicked without Shift.
let anchorId: string | null = null

// The agent moves the area of interest as it works: a resolved place becomes
// the area, and the map shows it straight away rather than after the search,
// which can take half a minute. Through the area's history, so Ctrl+Z brings
// back the area the user had.
function followAgentArea(event: AgentEvent) {
  const aoiStore = useAoiStore.getState()
  const next = areaAfter(event, aoiStore.aoi)
  if (!next || (sameAoi(aoiStore.aoi, next) && aoiStore.aoi?.name === next.name)) return
  aoiStore.commit(next)
  if (event.type !== "area") aoiStore.flyTo()
}

// Set while a conversation's area is being restored, so the restore is not
// saved back as a change.
let restoringArea = false

function restoreArea(area: Aoi | null) {
  restoringArea = true
  useAoiStore.getState().reset(area)
  restoringArea = false
}

export const useChatStore = create<ChatState>((set, get) => {
  // Runs one turn against the open conversation. fromTurn=null appends;
  // a number replaces that turn and everything after it. `area` is the area of
  // interest sent with the prompt.
  const run = async (text: string, fromTurn: number | null, area: Aoi | null) => {
    if (get().streaming || !text.trim()) return
    const done = turnOnce(text, fromTurn, area)
    current = done
    try {
      await done
    } finally {
      if (current === done) current = null
      withdrawn = false
    }
  }

  const turnOnce = async (text: string, fromTurn: number | null, area: Aoi | null): Promise<void> => {
    let cid = get().conversationId
    // A conversation made here cannot have been deleted in between; this
    // stops the retry below from repeating.
    const fresh = !cid
    if (!cid) {
      try {
        const conv = await api.create()
        cid = conv.id
        set({ conversationId: cid, title: "" })
      } catch (err) {
        set({ error: (err as Error).message })
        return
      }
    }

    controller = new AbortController()
    let pending: SearchResult | null = null
    let gone = false
    // True once the model has started on the question. A question stopped
    // before that never reached the model, so it leaves no trace.
    let started = false
    const promptId = nextId()
    // Provisional until the server confirms the index in its first event.
    let turn =
      fromTurn ?? (get().timeline.reduce((max, i) => Math.max(max, i.turn), -1) + 1)
    const before = get().timeline

    set((s) => ({
      streaming: true,
      error: null,
      timeline: [
        ...(fromTurn === null ? s.timeline : s.timeline.filter((i) => i.turn < fromTurn)),
        // No area on the prompt yet: the chip appears when the server's
        // "area" event confirms the agent received it.
        { kind: "message", id: promptId, turn, role: "user", text },
      ],
    }))

    try {
      await streamChat(
        cid,
        text,
        fromTurn,
        area,
        (event) => {
          if (event.type === "waiting") {
            set({ waiting: { text, position: event.position, wait_s: event.wait_s } })
            return
          }
          if (event.type === "turn") {
            turn = event.idx
            started = true
            set({ waiting: null })
            return
          }
          if (event.type === "tool_result" && isSearchResult(event.result)) {
            // Scene results are buffered and plotted after the reply.
            pending = event.result
          }
          if (event.type === "error") {
            set({ error: event.message })
            return
          }
          followAgentArea(event)
          set((s) => ({ timeline: applyEvent(s.timeline, turn, event) }))
        },
        controller.signal,
      )
    } catch (err) {
      if (isGone(err) && !fresh) gone = true
      else if ((err as Error).name !== "AbortError") {
        set({ error: (err as Error).message })
      }
    } finally {
      set((s) => ({
        streaming: false,
        waiting: null,
        // A question taken back for a query (withdraw) never reached the
        // model and the server saved nothing: it leaves the panel, and an
        // edit or retry puts back the turns it was replacing.
        timeline: withdrawn && !started
          ? fromTurn === null
            ? s.timeline.filter((i) => i.id !== promptId)
            : before
          : s.timeline.map((i) =>
              i.kind === "tool" && i.turn === turn && i.status === "running" && i.server !== "map"
                ? { ...i, status: "failed" }
                : i,
            ),
      }))
      controller = null
      // Plot as a final step: add a running plot_scenes card, publish scenes,
      // reset filters. The map layer resolves the card via finishPlot(). A
      // search that found nothing still clears the map, but gets no card:
      // there is nothing to plot.
      if (pending) {
        const found: SearchResult = pending
        const scenes = scenesOf(found)
        const card = scenes.length ? plotCard(turn, scenes.length, "running") : null
        set((s) => ({
          timeline: card ? [...s.timeline, card] : s.timeline,
          scenes,
          moreScenes: !!found.more_available,
          timeRange: null,
          satelliteFilter: ALL_SATELLITES,
          selectedSceneId: null,
          chosenIds: NONE_CHOSEN,
          pendingPlotId: card?.id ?? null,
        }))
        // Fallback if the map never reports back (e.g. no drawable footprints).
        if (card) setTimeout(() => get().finishPlot(), 4000)
      }
      void get().refreshList()
    }
    // The conversation was deleted while this page had it open (after days
    // without use): ask the same question in a new one, keeping the area.
    if (gone) {
      startOver()
      await run(text, null, area)
    }
  }

  // Leaves a deleted conversation for a blank one, keeping the area on the map.
  const startOver = () =>
    set({ conversationId: null, title: "", timeline: [], error: null, streaming: false, ...emptyResults })

  return {
    conversationId: null,
    title: "",
    conversations: [],
    retentionDays: null,
    timeline: [],
    streaming: false,
    waiting: null,
    error: null,
    ...emptyResults,
    zoomRequest: 0,

    setTimeRange: (range) => set({ timeRange: range }),
    setSatelliteFilter: (sats) => set({ satelliteFilter: sats.length ? sats : ALL_SATELLITES }),
    chooseScene: (id, how, order) =>
      set((s) => {
        if (how === "run" && anchorId && order.includes(anchorId) && order.includes(id)) {
          const from = Math.min(order.indexOf(anchorId), order.indexOf(id))
          const to = Math.max(order.indexOf(anchorId), order.indexOf(id))
          return { chosenIds: order.slice(from, to + 1), selectedSceneId: id }
        }
        anchorId = id
        if (how === "toggle" && s.chosenIds.includes(id)) {
          const chosenIds = s.chosenIds.filter((c) => c !== id)
          return { chosenIds, selectedSceneId: s.selectedSceneId === id ? null : s.selectedSceneId }
        }
        return { chosenIds: how === "toggle" ? [...s.chosenIds, id] : [id], selectedSceneId: id }
      }),
    closeScene: () =>
      set((s) => ({
        selectedSceneId: null,
        chosenIds: s.chosenIds.filter((c) => c !== s.selectedSceneId),
      })),
    clearChosen: () => set({ selectedSceneId: null, chosenIds: NONE_CHOSEN }),
    requestZoom: () => set((s) => ({ zoomRequest: s.zoomRequest + 1 })),

    runQuery: async (query, fromTurn) => {
      if (get().streaming) return false
      let cid = get().conversationId
      const fresh = !cid
      try {
        if (!cid) {
          cid = (await api.create()).id
          set({ conversationId: cid, title: "" })
        }
        const turn = await api.query(cid, query, fromTurn)
        let timeline: TimelineItem[] = [
          ...(fromTurn === null ? get().timeline : get().timeline.filter((i) => i.turn < fromTurn)),
          { kind: "message", id: nextId(), turn: turn.idx, role: "user", text: turn.prompt },
        ]
        let found: SearchResult | null = null
        for (const e of turn.events) {
          timeline = applyEvent(timeline, turn.idx, e)
          if (e.type === "tool_result" && isSearchResult(e.result)) found = e.result
        }
        const scenes = scenesOf(found)
        const card = scenes.length ? plotCard(turn.idx, scenes.length, "running") : null
        set({
          error: null,
          timeline: card ? [...timeline, card] : timeline,
          scenes,
          moreScenes: !!found?.more_available,
          timeRange: null,
          satelliteFilter: ALL_SATELLITES,
          selectedSceneId: null,
          chosenIds: NONE_CHOSEN,
          pendingPlotId: card?.id ?? null,
        })
        if (card) setTimeout(() => get().finishPlot(), 4000)
        if (query.area) followAgentArea({ type: "area", area: query.area })
        void get().refreshList()
        return true
      } catch (err) {
        // Deleted after days without use: run the query in a new conversation.
        if (isGone(err) && !fresh) {
          startOver()
          return get().runQuery(query, null)
        }
        set({ error: (err as Error).message })
        return false
      }
    },

    // Called by the map layer once footprints are drawn and framed.
    finishPlot: () =>
      set((s) => {
        if (!s.pendingPlotId) return s
        const timeline = s.timeline.map((i) =>
          i.kind === "tool" && i.id === s.pendingPlotId ? { ...i, status: "succeeded" as const } : i,
        )
        return { timeline, pendingPlotId: null }
      }),

    send: (text) => run(text, null, useAoiStore.getState().aoi),
    // A rerun asks with the area the prompt was first sent with.
    rerun: (turn, text) => {
      const prompt = get().timeline.find((i) => i.kind === "message" && i.role === "user" && i.turn === turn)
      return run(text, turn, prompt?.kind === "message" ? (prompt.area ?? null) : null)
    },

    stop: () => {
      controller?.abort()
      set({ streaming: false })
    },

    withdraw: async () => {
      if (!get().waiting || !controller) return
      withdrawn = true
      controller.abort()
      await current
    },

    // A blank screen; the conversation itself is created by the first prompt.
    newConversation: () => {
      controller?.abort()
      set({ conversationId: null, title: "", timeline: [], error: null, streaming: false, ...emptyResults })
      restoreArea(null)
    },

    refreshList: async () => {
      try {
        const { conversations, retention_days } = await api.list()
        const current = conversations.find((c) => c.id === get().conversationId)
        set({
          conversations,
          retentionDays: retention_days ?? null,
          ...(current ? { title: current.title } : {}),
        })
      } catch {
        // The list is a convenience; a failed refresh keeps the old one.
      }
    },

    open: async (id) => {
      controller?.abort()
      let conv: Conversation
      try {
        conv = await api.get(id)
      } catch (err) {
        // Deleted after days without use: drop it from the list, no error.
        if (isGone(err)) {
          set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id) }))
          if (get().conversationId === id) get().newConversation()
          return
        }
        set({ error: (err as Error).message })
        return
      }
      const { timeline, scenes, moreScenes } = replay(conv.turns)
      const selected = conv.state.selectedSceneId ?? null
      // A new scenes array makes the map layer redraw and reframe.
      set({
        conversationId: conv.id,
        title: conv.title,
        timeline,
        streaming: false,
        error: null,
        scenes,
        moreScenes,
        timeRange: conv.state.timeRange ?? null,
        satelliteFilter: savedSatellites(conv.state.satelliteFilter, scenes),
        selectedSceneId: selected && scenes.some((sc) => sc.id === selected) ? selected : null,
        chosenIds: savedChoice(conv.state, scenes),
        pendingPlotId: null,
      })
      // The saved area; conversations from before areas were saved rebuild it
      // from their turns. After the switch above, so it is not saved into the
      // conversation being left.
      const area = "aoi" in conv.state ? (conv.state.aoi ?? null) : areaFromTurns(conv.turns)
      restoreArea(area)
      // With scenes the map fits them; without, it shows the area.
      if (area && !scenes.length) useAoiStore.getState().flyTo()
    },

    rename: async (id, title) => {
      const clean = title.trim()
      if (!clean) return
      await api.patch(id, { title: clean })
      if (get().conversationId === id) set({ title: clean })
      await get().refreshList()
    },

    fork: async (id, upto) => {
      const conv = await api.fork(id, upto)
      await get().refreshList()
      await get().open(conv.id)
    },

    remove: async (id) => {
      await api.remove(id)
      if (get().conversationId === id) get().newConversation()
      await get().refreshList()
    },
  }
})

// The chosen scenes of a saved conversation that are still in its results.
// Saves from before several could be chosen hold only the open scene.
function savedChoice(state: ConversationState, scenes: Scene[]): string[] {
  const ids = new Set(scenes.map((s) => s.id))
  const saved = state.chosenIds ?? (state.selectedSceneId ? [state.selectedSceneId] : [])
  const kept = saved.filter((id) => ids.has(id))
  return kept.length ? kept : NONE_CHOSEN
}

// Map/filter state and the area are saved against the open conversation
// shortly after they change, so resuming restores the same view. The API
// replaces the whole state object, so every save sends all of it.
let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave() {
  const s = useChatStore.getState()
  const id = s.conversationId
  if (!id) return
  const state = {
    selectedSceneId: s.selectedSceneId,
    chosenIds: s.chosenIds,
    timeRange: s.timeRange,
    satelliteFilter: s.satelliteFilter,
    aoi: useAoiStore.getState().aoi,
  }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void api.patch(id, { state }).catch(() => {}), 400)
}

useChatStore.subscribe((s, prev) => {
  if (!s.conversationId || s.conversationId !== prev.conversationId) return
  if (
    s.selectedSceneId === prev.selectedSceneId &&
    s.chosenIds === prev.chosenIds &&
    s.timeRange === prev.timeRange &&
    s.satelliteFilter === prev.satelliteFilter
  )
    return
  scheduleSave()
})

useAoiStore.subscribe((s, prev) => {
  if (s.aoi !== prev.aoi && !restoringArea) scheduleSave()
})
