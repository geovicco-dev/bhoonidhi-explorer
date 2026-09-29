import { create } from "zustand"

// How the open scene's quicklook shows on the map. One opacity for every
// quicklook, kept while browsing scenes; `visible` is the O key's hide/show,
// for a look at the basemap underneath.
type QuicklookState = {
  // 0 to 100.
  opacity: number
  visible: boolean
  // The scene whose quicklook is on the map now, set once its image has
  // loaded (ISRO's host can take half a minute).
  drapedId: string | null
  setOpacity: (opacity: number) => void
  toggleVisible: () => void
  setDraped: (id: string | null) => void
}

export const useQuicklookStore = create<QuicklookState>()((set) => ({
  opacity: 90,
  visible: true,
  drapedId: null,
  // Moving the slider on a hidden quicklook shows it again.
  setOpacity: (opacity) => set({ opacity, visible: true }),
  toggleVisible: () => set((s) => ({ visible: !s.visible })),
  setDraped: (drapedId) => set({ drapedId }),
}))
