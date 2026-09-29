import { env } from "@/lib/env"
import { failure } from "@/lib/http"
import type { Scene } from "@/features/chat/types"

// What hands one scene over to a download: the `bhd` commands, and a prompt
// for an agent with the bhoonidhi MCP server.
export type Handoff = { bhd: string; prompt: string }

export async function sceneHandoff(scene: Scene): Promise<Handoff> {
  const res = await fetch(`${env.agentApiUrl}/scene/handoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scene }),
  })
  if (!res.ok) throw await failure(res, "/scene/handoff")
  const out = (await res.json()) as Partial<Handoff> & { error?: string }
  if (!out.bhd || !out.prompt) throw new Error(out.error ?? "No download steps for this scene.")
  return { bhd: out.bhd, prompt: out.prompt }
}

// The same for several chosen scenes: one saved search and a download of
// exactly those scenes.
export async function scenesHandoff(scenes: Scene[]): Promise<Handoff> {
  const res = await fetch(`${env.agentApiUrl}/scenes/handoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenes }),
  })
  if (!res.ok) throw await failure(res, "/scenes/handoff")
  const out = (await res.json()) as Partial<Handoff> & { error?: string }
  if (!out.bhd || !out.prompt) throw new Error(out.error ?? "No download steps for these scenes.")
  return { bhd: out.bhd, prompt: out.prompt }
}
