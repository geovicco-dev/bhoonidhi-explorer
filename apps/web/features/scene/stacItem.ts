"use client"

import { useEffect, useState } from "react"
import { env } from "@/lib/env"
import type { Scene } from "@/features/chat/types"

// Where a scene's STAC item opens: the STAC API's address for browsers, from
// the API's /config, which a self-hosted explorer sets without rebuilding.
// Read once per page; a failed read is tried again on the next card.

// undefined until read; null when the server names no STAC API.
let base: string | null | undefined
let reading: Promise<string | null> | null = null

function stacPublicUrl(): Promise<string | null> {
  reading ??= fetch(`${env.agentApiUrl}/config`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`/config -> ${res.status}`)
      const config = (await res.json()) as { stac_public_url?: string | null }
      base = config.stac_public_url ?? null
      return base
    })
    .catch(() => {
      reading = null
      return null
    })
  return reading
}

function stacItemUrl(stacUrl: string, collection: string, id: string): string {
  return `${stacUrl}/collections/${encodeURIComponent(collection)}/items/${encodeURIComponent(id)}`
}

// The scene's item URL, or null while the address is unknown or the scene
// names no collection.
export function useStacItemUrl(scene: Scene): string | null {
  const [stacUrl, setStacUrl] = useState<string | null>(base ?? null)

  useEffect(() => {
    if (base !== undefined) return
    let live = true
    void stacPublicUrl().then((url) => live && setStacUrl(url))
    return () => {
      live = false
    }
  }, [])

  return stacUrl && scene.collection ? stacItemUrl(stacUrl, scene.collection, scene.id) : null
}
