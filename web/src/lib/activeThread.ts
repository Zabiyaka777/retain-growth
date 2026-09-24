// Which thread the agent currently has open, readable from outside the Chats
// page. The notification sound lives in the layout (it must ring on every
// page, not only /dashboard/chats), so it needs to know what Chats is showing
// in order to stay quiet during an active conversation.
//
// A module-level value rather than context: it's read inside a Realtime
// callback, never rendered, so making it state would only add re-renders and
// stale-closure risk for no benefit.

let activeThreadId: string | null = null

export function setActiveThreadId(threadId: string | null): void {
  activeThreadId = threadId
}

export function getActiveThreadId(): string | null {
  return activeThreadId
}
