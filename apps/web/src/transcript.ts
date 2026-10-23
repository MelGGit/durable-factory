import type {
  ToolView,
  TranscriptEntry,
} from '../../../packages/shared/src/index.js';

export type ConversationItem =
  | { kind: 'message'; key: string; entry: TranscriptEntry }
  | { kind: 'tool'; key: string; tool: PresentationTool };

export type PresentationTool = ToolView & { inputArtifact?: string };

/** Presentation only: keep durable entries intact and pair results by call ID. */
export function conversationItems(
  entries: readonly TranscriptEntry[],
  live: readonly ToolView[] = [],
): ConversationItem[] {
  const tools = new Map<string, PresentationTool>();
  const merge = (tool: PresentationTool) => {
    const previous = tools.get(tool.id);
    const defined = Object.fromEntries(
      Object.entries(tool).filter(([, value]) => value !== undefined),
    );
    tools.set(tool.id, { ...previous, ...defined } as PresentationTool);
  };
  // Durable results win over stale live slots, including failed results.
  for (const entry of entries)
    if (entry.kind !== 'pi.tool-result')
      entry.tools.forEach(({ artifact, ...tool }) =>
        merge({ ...tool, ...(artifact ? { inputArtifact: artifact } : {}) }),
      );
  live.forEach(merge);
  for (const entry of entries)
    if (entry.kind === 'pi.tool-result') entry.tools.forEach(merge);

  const items: ConversationItem[] = [];
  const rendered = new Set<string>();
  const append = (tool: ToolView) => {
    if (rendered.has(tool.id)) return;
    rendered.add(tool.id);
    items.push({
      kind: 'tool',
      key: `tool:${tool.id}`,
      tool: tools.get(tool.id)!,
    });
  };
  for (const entry of entries) {
    if (entry.text || entry.textArtifact || entry.interrupted)
      items.push({ kind: 'message', key: `entry:${entry.id}`, entry });
    entry.tools.forEach(append);
  }
  live.forEach(append);
  return items;
}

export function agentLabel(role?: string) {
  return role === 'development'
    ? 'Development agent'
    : role === 'review'
      ? 'Review agent'
      : 'Planning agent';
}
