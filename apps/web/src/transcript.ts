import type {
  ToolView,
  TranscriptEntry,
} from '../../../packages/shared/src/index.js';

export type ConversationItem =
  | { kind: 'message'; key: string; entry: TranscriptEntry }
  | { kind: 'tool'; key: string; tool: PresentationTool };

export type PresentationTool = ToolView & { inputArtifact?: string };

export interface ActivityCall {
  tool: PresentationTool;
  conversationId: string;
  attemptId?: string;
  agent?: string;
  at?: number;
}

export interface ResponseSpeaker {
  conversationId: string;
  attemptId?: string;
  author: string;
}
export type ResponsePartDescription =
  | { kind: 'agent'; speaker: ResponseSpeaker; at?: number; closes?: boolean }
  | { kind: 'workflow'; attemptId?: string }
  | { kind: 'boundary' };

/** Preserve chronology while treating one agent's text and activity as a response. */
export function groupResponseFlow<T>(
  items: readonly T[],
  describe: (item: T) => ResponsePartDescription,
) {
  const blocks: (
    | {
        kind: 'response';
        speaker: ResponseSpeaker;
        at?: number;
        closed: boolean;
        items: T[];
      }
    | { kind: 'standalone'; item: T }
  )[] = [];
  for (const item of items) {
    const part = describe(item);
    const previous = blocks.at(-1);
    if (part.kind === 'boundary') blocks.push({ kind: 'standalone', item });
    else if (part.kind === 'workflow') {
      if (
        previous?.kind === 'response' &&
        !previous.closed &&
        (part.attemptId === undefined ||
          part.attemptId === previous.speaker.attemptId)
      )
        previous.items.push(item);
      else blocks.push({ kind: 'standalone', item });
    } else if (
      previous?.kind === 'response' &&
      !previous.closed &&
      previous.speaker.conversationId === part.speaker.conversationId &&
      previous.speaker.attemptId === part.speaker.attemptId &&
      previous.speaker.author === part.speaker.author
    ) {
      previous.items.push(item);
      previous.at ??= part.at;
      previous.closed = Boolean(part.closes);
    } else
      blocks.push({
        kind: 'response',
        speaker: part.speaker,
        at: part.at,
        closed: Boolean(part.closes),
        items: [item],
      });
  }
  return blocks;
}

/** Only presentation neighbors can share a disclosure; content is a boundary. */
export function groupToolActivity<T>(
  items: readonly T[],
  callFor: (item: T) => ActivityCall | undefined,
) {
  const groups: (
    | { kind: 'tools'; calls: ActivityCall[] }
    | { kind: 'content'; item: T }
  )[] = [];
  for (const item of items) {
    const call = callFor(item);
    const previous = groups.at(-1);
    if (!call) groups.push({ kind: 'content', item });
    else if (
      previous?.kind === 'tools' &&
      previous.calls[0].conversationId === call.conversationId &&
      previous.calls[0].attemptId === call.attemptId &&
      previous.calls[0].agent === call.agent
    )
      previous.calls.push(call);
    else groups.push({ kind: 'tools', calls: [call] });
  }
  return groups;
}

const actions: Record<string, [string, string, string?]> = {
  read: ['Read', 'Reading', 'files'],
  read_file: ['Read', 'Reading', 'files'],
  read_repository: ['Read', 'Reading', 'files'],
  worktree_read: ['Read', 'Reading', 'files'],
  worktree_write: ['Wrote', 'Writing', 'files'],
  worktree_edit: ['Edited', 'Editing', 'files'],
  worktree_command: ['Ran', 'Running', 'commands'],
  bash: ['Ran', 'Running', 'commands'],
  list_repository: ['Listed repository files', 'Listing repository files'],
  worktree_list: ['Listed repository files', 'Listing repository files'],
  search_repository: ['Searched repository', 'Searching repository'],
  search_history: ['Searched conversation', 'Searching conversation'],
  repository_changes: ['Inspected changes', 'Inspecting changes'],
  worktree_diff: ['Inspected changes', 'Inspecting changes'],
  read_issue_context: ['Read issue context', 'Reading issue context'],
  save_ticket: ['Saved ticket', 'Saving ticket'],
  propose_issue: ['Proposed issue', 'Proposing issue'],
  create_issue: ['Created issue', 'Creating issue'],
  update_issue: ['Updated issue', 'Updating issue'],
  start_development: ['Started development', 'Starting development'],
  include_generated_file: [
    'Included generated file',
    'Including generated file',
  ],
  workflow_question: ['Asked a question', 'Asking a question'],
  submit_implementation: [
    'Submitted implementation',
    'Submitting implementation',
  ],
  submit_review: ['Submitted review', 'Submitting review'],
  workflow_evidence: ['Read workflow evidence', 'Reading workflow evidence'],
};

function toolArguments(tool: PresentationTool): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(tool.arguments ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    // Argument previews can be partial while streaming, or deliberately bounded.
    return {};
  }
}

export function toolLabel(tool: PresentationTool) {
  const action = Object.hasOwn(actions, tool.name)
    ? actions[tool.name]
    : undefined;
  if (!action) return tool.name;
  const active = tool.status === 'pending' || tool.status === 'running';
  const args = toolArguments(tool);
  const target =
    action[2] === 'files'
      ? args.path
      : action[2] === 'commands'
        ? args.command
        : tool.name.startsWith('search_')
          ? args.query
          : tool.name === 'include_generated_file'
            ? args.path
            : undefined;
  const verb = action[active ? 1 : 0];
  return typeof target === 'string' && target.trim()
    ? `${verb} ${target.replace(/\s+/g, ' ').trim()}`
    : action[2] === 'files'
      ? `${verb} a file`
      : action[2] === 'commands'
        ? `${verb} a command`
        : verb;
}

export function toolGroupLabel(tools: readonly PresentationTool[]) {
  const active =
    tools.findLast((tool) => tool.status === 'running') ??
    tools.findLast((tool) => tool.status === 'pending');
  if (active) return `${toolLabel(active)} · ${tools.length} calls`;
  if (tools.some((tool) => tool.status === 'failed'))
    return `${tools.length} tool calls`;
  const counts = new Map<
    string,
    { verb: string; noun: string; count: number; paths: Set<string> }
  >();
  for (const tool of tools) {
    const action = Object.hasOwn(actions, tool.name)
      ? actions[tool.name]
      : undefined;
    const noun = action?.[2] ?? 'tools';
    const verb = action?.[2] ? action[0] : 'Used';
    const key = `${verb}:${noun}`;
    const count = counts.get(key) ?? {
      verb,
      noun,
      count: 0,
      paths: new Set<string>(),
    };
    const path = toolArguments(tool).path;
    if (noun === 'files' && typeof path === 'string' && path.trim())
      count.paths.add(path);
    else count.count++;
    counts.set(key, count);
  }
  return [...counts.values()]
    .map(({ verb, noun, count, paths }, index) => {
      const total = count + paths.size;
      return `${index ? verb.toLowerCase() : verb} ${total} ${total === 1 ? noun.slice(0, -1) : noun}`;
    })
    .join(', ');
}

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
    if (entry.parts?.length) {
      for (const [index, part] of entry.parts.entries()) {
        if (part.type === 'tool') {
          const tool = tools.get(part.toolId);
          if (tool) append(tool);
        } else
          items.push({
            kind: 'message',
            key: `part:${part.id}`,
            entry: {
              ...entry,
              text: part.type === 'text' ? part.text : '',
              parts: [part],
              textArtifact: undefined,
              interrupted:
                index === entry.parts.length - 1 && entry.interrupted,
            },
          });
      }
      if (entry.interrupted && entry.parts.at(-1)?.type === 'tool')
        items.push({
          kind: 'message',
          key: `entry:${entry.id}:interrupted`,
          entry: { ...entry, parts: [], text: '' },
        });
    } else if (entry.text || entry.textArtifact || entry.interrupted)
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
