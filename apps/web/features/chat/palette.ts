import type { PaletteItem, PalettePage } from "@/features/palette/types"
import type { ConversationSummary } from "./stream"

// Conversation pages for the palette: the list, one conversation's actions,
// and a rename input. Page ids: "conversations", "conv:<id>", "conv-rename:<id>".

const CONVERSATIONS_PAGE = "conversations"
export const convPage = (id: string) => `conv:${id}`
const renamePage = (id: string) => `conv-rename:${id}`

type Actions = {
  currentId: string | null
  streaming: boolean
  open: (id: string) => void
  newConversation: () => void
  rename: (id: string, title: string) => void
  fork: (id: string) => void
  remove: (id: string) => void
}

export function ago(seconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - seconds)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const days = Math.floor(s / 86400)
  return days === 1 ? "yesterday" : `${days} days ago`
}

function label(c: ConversationSummary): string {
  return c.title || "Untitled"
}

function conversationItem(c: ConversationSummary, currentId: string | null, searchOnly = false): PaletteItem {
  return {
    id: `conv-item:${c.id}`,
    label: label(c),
    detail: `${c.turns} prompt${c.turns === 1 ? "" : "s"} · ${ago(c.updated_at)}`,
    hint: c.id === currentId ? "open" : undefined,
    section: "Sessions",
    searchOnly,
    pageId: convPage(c.id),
  }
}

// Root entries: new conversation, the full list, and every conversation by
// title (found by typing).
export function conversationRootItems(conversations: ConversationSummary[], a: Actions): PaletteItem[] {
  return [
    {
      id: "conv:new",
      label: "New session",
      keywords: "new conversation chat start fresh clear reset search",
      section: "Sessions",
      hint: "\\n",
      disabled: a.streaming,
      run: a.newConversation,
    },
    {
      id: "conv:list",
      label: "Sessions",
      keywords: "history conversations resume previous saved",
      hint: conversations.length ? `${conversations.length}` : undefined,
      section: "Sessions",
      pageId: CONVERSATIONS_PAGE,
    },
    ...conversations.map((c) => conversationItem(c, a.currentId, true)),
  ]
}

export function conversationPage(
  pageId: string,
  conversations: ConversationSummary[],
  a: Actions,
): PalettePage | null {
  if (pageId === CONVERSATIONS_PAGE) {
    return {
      id: pageId,
      title: "Sessions",
      placeholder: "Filter sessions…",
      items: conversations.map((c) => ({ ...conversationItem(c, a.currentId), section: undefined })),
    }
  }

  if (pageId.startsWith("conv-rename:")) {
    const id = pageId.slice("conv-rename:".length)
    return {
      id: pageId,
      title: "Rename",
      placeholder: "New name…",
      items: [],
      onSubmit: (text) => a.rename(id, text),
      submitLabel: "rename",
    }
  }

  if (pageId.startsWith("conv:")) {
    const id = pageId.slice("conv:".length)
    const c = conversations.find((x) => x.id === id)
    if (!c) return { id: pageId, title: "Session", items: [], error: "This session no longer exists." }
    const isOpen = id === a.currentId
    return {
      id: pageId,
      title: label(c),
      placeholder: "Choose an action…",
      items: [
        {
          id: `${pageId}:open`,
          label: isOpen ? "Already open" : "Open",
          keywords: "resume continue load",
          disabled: isOpen || a.streaming,
          run: () => a.open(id),
        },
        {
          id: `${pageId}:rename`,
          label: "Rename",
          pageId: renamePage(id),
          pageQuery: c.title,
        },
        {
          id: `${pageId}:fork`,
          label: "Fork",
          keywords: "copy duplicate branch",
          detail: "Copy it into a new session and open the copy",
          disabled: a.streaming,
          run: () => a.fork(id),
        },
        {
          id: `${pageId}:delete`,
          label: "Delete",
          keywords: "remove",
          detail: "Removes it and its results; this cannot be undone",
          disabled: isOpen && a.streaming,
          run: () => a.remove(id),
        },
      ],
    }
  }
  return null
}
