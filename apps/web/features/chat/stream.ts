import { env } from "@/lib/env"
import { failure } from "@/lib/http"
import type { Aoi } from "@/features/aoi/types"
import type { Query } from "@/features/query/store"
import type { AgentEvent } from "./types"

// Anonymous per-browser id; the API scopes conversations to it.
const CLIENT_KEY = "bhoonidhi.clientId"

function clientId(): string {
  let id = localStorage.getItem(CLIENT_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(CLIENT_KEY, id)
  }
  return id
}

function headers(json = false): HeadersInit {
  return { "X-Client-Id": clientId(), ...(json ? { "Content-Type": "application/json" } : {}) }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${env.agentApiUrl}${path}`, init)
  if (!res.ok) throw await failure(res, `${init.method ?? "GET"} ${path}`)
  return (await res.json()) as T
}

export type ConversationSummary = {
  id: string
  title: string
  forked_from: string | null
  created_at: number
  updated_at: number
  turns: number
}

export type StoredTurn = { idx: number; prompt: string; events: AgentEvent[]; created_at: number }

// Map/filter state restored on resume.
export type ConversationState = {
  selectedSceneId?: string | null
  chosenIds?: string[]
  timeRange?: [number, number] | null
  // Chosen satellite codes. Saves from before several could be chosen hold
  // one code or null.
  satelliteFilter?: string[] | string | null
  aoi?: Aoi | null
}

export type Conversation = Omit<ConversationSummary, "turns"> & {
  state: ConversationState
  turns: StoredTurn[]
}

export type Place = {
  name: string
  detail: string
  kind: string | null
  lat: number
  lon: number
  bbox: { west: number; south: number; east: number; north: number }
}

export const api = {
  list: () =>
    call<{ conversations: ConversationSummary[]; retention_days?: number }>("/conversations", { headers: headers() }),
  create: () => call<Conversation>("/conversations", { method: "POST", headers: headers() }),
  get: (id: string) => call<Conversation>(`/conversations/${id}`, { headers: headers() }),
  patch: (id: string, body: { title?: string; state?: ConversationState }) =>
    call<{ ok: true }>(`/conversations/${id}`, {
      method: "PATCH",
      headers: headers(true),
      body: JSON.stringify(body),
    }),
  remove: (id: string) => call<{ ok: true }>(`/conversations/${id}`, { method: "DELETE", headers: headers() }),
  fork: (id: string, upto?: number) =>
    call<Conversation>(`/conversations/${id}/fork`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(upto === undefined ? {} : { upto }),
    }),
  geocode: (q: string) => call<{ places: Place[] }>(`/geocode?q=${encodeURIComponent(q)}`),
  // Run a query from the form and save it as a turn; 422 when it has problems.
  query: async (id: string, query: Query, fromTurn: number | null) => {
    const res = await fetch(`${env.agentApiUrl}/conversations/${id}/query`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(fromTurn === null ? { query } : { query, from_turn: fromTurn }),
    })
    if (res.status === 422) throw new Error("The query has problems to fix before it can run.")
    if (!res.ok) throw await failure(res, "query")
    return (await res.json()) as { idx: number; prompt: string; events: AgentEvent[] }
  },
}

// /chat is a POST returning an SSE body; EventSource is GET-only, so the
// fetch stream is parsed by hand.
export async function streamChat(
  conversationId: string,
  message: string,
  fromTurn: number | null,
  area: Aoi | null,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const body: { message: string; from_turn?: number; area?: Aoi } = { message }
  if (fromTurn !== null) body.from_turn = fromTurn
  if (area) body.area = area
  const res = await fetch(`${env.agentApiUrl}/conversations/${conversationId}/chat`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw await failure(res, "agent /chat")

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Frames are blank-line separated, one `data:` field each.
    let sep: number
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const line = frame.split("\n").find((l) => l.startsWith("data: "))
      if (!line) continue
      try {
        onEvent(JSON.parse(line.slice(6)) as AgentEvent)
      } catch {
        // A malformed frame must not tear down the stream.
      }
    }
  }
}
