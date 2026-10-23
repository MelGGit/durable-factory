export const chatStorageKey = 'factory.chat.v1';
export type PendingSend = {
  conversationId: string;
  content: string;
  requestId: string;
};
export type ChatLocalState = {
  selected: string;
  drafts: Record<string, string>;
  pending: PendingSend[];
  creation?: { title: string; requestId: string };
};
const draftPrefix = `${chatStorageKey}.draft.`;
const pendingPrefix = `${chatStorageKey}.pending.`;
const selectionKey = `${chatStorageKey}.selected`;
const creationKey = `${chatStorageKey}.creation`;

function isPending(value: unknown): value is PendingSend {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'conversationId' in value &&
      typeof value.conversationId === 'string' &&
      'requestId' in value &&
      typeof value.requestId === 'string' &&
      'content' in value &&
      typeof value.content === 'string',
  );
}
function migrateLegacy() {
  const raw = localStorage.getItem(chatStorageKey);
  if (!raw) return;
  const legacy = JSON.parse(raw) as ChatLocalState;
  if (
    !legacy ||
    typeof legacy.selected !== 'string' ||
    !legacy.drafts ||
    !Array.isArray(legacy.pending)
  )
    return;
  for (const [id, draft] of Object.entries(legacy.drafts)) {
    if (
      typeof draft === 'string' &&
      localStorage.getItem(draftPrefix + id) === null
    )
      localStorage.setItem(draftPrefix + id, draft);
  }
  for (const pending of legacy.pending) {
    if (
      isPending(pending) &&
      localStorage.getItem(pendingPrefix + pending.requestId) === null
    )
      localStorage.setItem(
        pendingPrefix + pending.requestId,
        JSON.stringify(pending),
      );
  }
  if (localStorage.getItem(selectionKey) === null)
    localStorage.setItem(selectionKey, legacy.selected);
  if (legacy.creation && sessionStorage.getItem(creationKey) === null)
    sessionStorage.setItem(creationKey, JSON.stringify(legacy.creation));
  localStorage.removeItem(chatStorageKey);
}
export function restoreChatState(): ChatLocalState {
  const result: ChatLocalState = { selected: '', drafts: {}, pending: [] };
  try {
    migrateLegacy();
    result.selected =
      sessionStorage.getItem(selectionKey) ??
      localStorage.getItem(selectionKey) ??
      '';
    if (sessionStorage.getItem(selectionKey) === null)
      sessionStorage.setItem(selectionKey, result.selected);
    const creation = JSON.parse(sessionStorage.getItem(creationKey) ?? 'null');
    if (
      creation &&
      typeof creation.title === 'string' &&
      typeof creation.requestId === 'string'
    )
      result.creation = creation;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (key.startsWith(draftPrefix))
        result.drafts[key.slice(draftPrefix.length)] =
          localStorage.getItem(key) ?? '';
      if (key.startsWith(pendingPrefix)) {
        try {
          const pending = JSON.parse(localStorage.getItem(key) ?? 'null');
          if (isPending(pending)) result.pending.push(pending);
        } catch {
          /* One damaged record must not hide other drafts or sends. */
        }
      }
    }
  } catch {
    /* Keep the chat usable when browser storage is unavailable. */
  }
  return result;
}
/** Write only changed records: another tab owns its own edits and request IDs. */
export function saveChatChanges(
  previous: ChatLocalState,
  next: ChatLocalState,
) {
  if (previous.selected !== next.selected) {
    sessionStorage.setItem(selectionKey, next.selected);
    localStorage.setItem(selectionKey, next.selected);
  }
  for (const id of new Set([
    ...Object.keys(previous.drafts),
    ...Object.keys(next.drafts),
  ])) {
    if (previous.drafts[id] === next.drafts[id]) continue;
    const key = draftPrefix + id;
    const stored = localStorage.getItem(key);
    // An acknowledgement for an old send must not erase newer text from another tab.
    if (!next.drafts[id] && stored !== null && stored !== previous.drafts[id]) {
      next.drafts[id] = stored;
    } else if (next.drafts[id] === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, next.drafts[id]);
  }
  const before = new Map(
    previous.pending.map((item) => [item.requestId, item]),
  );
  const after = new Map(next.pending.map((item) => [item.requestId, item]));
  for (const [id, pending] of after)
    if (!before.has(id))
      localStorage.setItem(pendingPrefix + id, JSON.stringify(pending));
  for (const id of before.keys())
    if (!after.has(id)) localStorage.removeItem(pendingPrefix + id);
  if (previous.creation !== next.creation) {
    if (next.creation)
      sessionStorage.setItem(creationKey, JSON.stringify(next.creation));
    else sessionStorage.removeItem(creationKey);
  }
}
