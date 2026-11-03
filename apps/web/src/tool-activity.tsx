import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { ChatClient } from '../../../packages/shared/src/index.js';
import { ActivityDisclosure } from './activity-disclosure.js';
import {
  groupToolActivity,
  toolGroupLabel,
  toolLabel,
  type ActivityCall,
  type PresentationTool,
} from './transcript.js';

const client = new ChatClient();

/** Session-local state outlives reparenting a call as its group grows or moves. */
class ActivityState {
  private values = new Map<string, unknown>();
  private listeners = new Set<() => void>();
  private version = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  get<T>(key: string, initial: T): T {
    if (!this.values.has(key)) this.values.set(key, initial);
    return this.values.get(key) as T;
  }
  set<T>(key: string, value: T) {
    this.setMany([[key, value]]);
  }
  setMany(values: [string, unknown][]) {
    for (const [key, value] of values) this.values.set(key, value);
    this.version++;
    this.listeners.forEach((listener) => listener());
  }
}
const StateContext = createContext<ActivityState | undefined>(undefined);
function useActivityState() {
  const provided = useContext(StateContext);
  const [local] = useState(() => new ActivityState());
  const state = provided ?? local;
  useSyncExternalStore(state.subscribe, state.snapshot, state.snapshot);
  return state;
}
export function useCachedState<T>(key: string, initial: T) {
  const state = useActivityState();
  const value = state.get(key, initial);
  const set = (update: T | ((previous: T) => T)) => {
    const previous = state.get(key, initial);
    state.set(
      key,
      typeof update === 'function'
        ? (update as (value: T) => T)(previous)
        : update,
    );
  };
  return [value, set] as const;
}
const callKey = (call: ActivityCall) =>
  JSON.stringify([call.conversationId, call.tool.id]);
const emptyDisclosure = {
  open: false,
  groupOpen: false,
  failedSeen: false,
};

export function ArtifactText({
  artifact,
  conversationId,
  label = 'output',
  phase = 'completed',
}: {
  artifact: string;
  conversationId: string;
  label?: string;
  phase?: PresentationTool['status'];
}) {
  const [value, setValue] = useCachedState(
    JSON.stringify(['artifact', conversationId, artifact, label]),
    {
      output: '',
      offset: 0,
      exhaustedPhase: undefined as typeof phase | undefined,
      error: '',
      loading: false,
    },
  );
  const load = async () => {
    if (value.loading) return;
    setValue((previous) => ({ ...previous, loading: true }));
    try {
      const page = await client.artifact(
        conversationId,
        artifact,
        value.offset,
      );
      // EOF is temporary while running. Keep a byte cursor across completion
      // races and regrouping, including requests that resolve after a remount.
      setValue((previous) => ({
        ...previous,
        output: previous.output + page.text,
        offset:
          page.nextOffset ??
          value.offset + new TextEncoder().encode(page.text).byteLength,
        exhaustedPhase: page.nextOffset === undefined ? phase : undefined,
        error: '',
      }));
    } catch (error) {
      setValue((previous) => ({
        ...previous,
        error:
          error instanceof Error ? error.message : 'Could not load output.',
      }));
    } finally {
      setValue((previous) => ({ ...previous, loading: false }));
    }
  };
  return (
    <div className="artifact-output">
      {(phase === 'pending' ||
        phase === 'running' ||
        value.exhaustedPhase !== phase) && (
        <button
          type="button"
          disabled={value.loading}
          className="secondary"
          onClick={() => void load()}
        >
          {value.output ? `Load more ${label}` : `Read complete ${label}`}
        </button>
      )}
      {value.output && <pre>{value.output}</pre>}
      {value.error && <p role="alert">{value.error}</p>}
    </div>
  );
}

function Status({ tools }: { tools: readonly PresentationTool[] }) {
  const failed = tools.filter((tool) => tool.status === 'failed').length;
  const running = tools.some((tool) => tool.status === 'running');
  const pending = tools.some((tool) => tool.status === 'pending');
  return (
    <>
      {(running || pending) && (
        <span className="tool-indicator" aria-hidden="true" />
      )}
      <span className={`tool-status${failed ? ' tool-failed' : ''}`}>
        {failed ? (
          tools.length === 1 ? (
            'Failed'
          ) : (
            `${failed} failed`
          )
        ) : running ? (
          'Running'
        ) : pending ? (
          'Pending'
        ) : (
          <span className="sr-only">Completed</span>
        )}
      </span>
    </>
  );
}

export function Tool({
  tool,
  conversationId,
  agent,
  grouped = false,
  at,
}: ActivityCall & { grouped?: boolean }) {
  const [disclosure, setDisclosure] = useCachedState(
    callKey({ tool, conversationId }),
    emptyDisclosure,
  );
  useEffect(() => {
    if (tool.status === 'failed' && !disclosure.failedSeen)
      setDisclosure((previous) => ({
        ...previous,
        open: true,
        groupOpen: true,
        failedSeen: true,
      }));
  }, [tool.status, disclosure.failedSeen]);
  const label = toolLabel(tool);
  const content = (
    <ActivityDisclosure
      className="tool-card"
      data-tool-id={tool.id}
      data-conversation-item={`tool:${conversationId}:${tool.id}`}
      data-status={tool.status}
      open={disclosure.open}
      onOpenChange={(open) =>
        setDisclosure((previous) => ({
          ...previous,
          open,
          groupOpen: grouped ? previous.groupOpen : open,
        }))
      }
    >
      <summary>
        <strong className="tool-label" title={label}>
          {label}
        </strong>
        <Status tools={[tool]} />
      </summary>
      <div className="tool-detail">
        <div className="tool-name">
          {tool.name}
          {at !== undefined && (
            <time dateTime={new Date(at).toISOString()}>
              {new Date(at).toLocaleTimeString()}
            </time>
          )}
        </div>
        {tool.arguments !== undefined && (
          <>
            <h4>Input / command</h4>
            <pre>{tool.arguments}</pre>
          </>
        )}
        {tool.output !== undefined && (
          <>
            <h4>Output</h4>
            <pre>{tool.output}</pre>
          </>
        )}
        {tool.truncated && <p>Output preview is limited.</p>}
        {tool.inputArtifact && (
          <ArtifactText
            key={`input:${tool.inputArtifact}`}
            artifact={tool.inputArtifact}
            conversationId={conversationId}
            label="input"
          />
        )}
        {tool.artifact && (
          <ArtifactText
            key={`output:${tool.artifact}`}
            artifact={tool.artifact}
            conversationId={conversationId}
            phase={tool.status}
          />
        )}
      </div>
    </ActivityDisclosure>
  );
  return agent ? (
    <section className="tool-activity">
      <div className="tool-agent">{agent}</div>
      {content}
    </section>
  ) : (
    content
  );
}

function ToolGroup({
  calls,
  showAgent,
}: {
  calls: ActivityCall[];
  showAgent: boolean;
}) {
  const state = useActivityState();
  const disclosures = calls.map((call) =>
    state.get(callKey(call), emptyDisclosure),
  );
  const open = disclosures.some((value) => value.groupOpen);
  const tools = calls.map((call) => call.tool);
  const label = toolGroupLabel(tools);
  const last = calls.at(-1)!;
  return (
    <section className="tool-activity">
      {showAgent && calls[0].agent && (
        <div className="tool-agent">{calls[0].agent}</div>
      )}
      <ActivityDisclosure
        className="tool-group"
        open={open}
        onOpenChange={(expanded) => {
          state.setMany(
            calls.map((call) => {
              const key = callKey(call);
              return [
                key,
                { ...state.get(key, emptyDisclosure), groupOpen: expanded },
              ];
            }),
          );
        }}
      >
        <summary
          data-conversation-item={`tool-group:${last.conversationId}:${last.tool.id}`}
        >
          <span className="tool-label" title={label}>
            {label}
          </span>
          <Status tools={tools} />
        </summary>
        <div className="tool-list">
          {calls.map((call) => (
            <Tool key={callKey(call)} {...call} agent={undefined} grouped />
          ))}
        </div>
      </ActivityDisclosure>
    </section>
  );
}

/** Content stays in transcript order; only adjacent top-level calls are grouped. */
export function ToolActivityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state] = useState(() => new ActivityState());
  return (
    <StateContext.Provider value={state}>{children}</StateContext.Provider>
  );
}

export function ToolActivity({
  children,
  showAgent = true,
}: {
  children: React.ReactNode;
  showAgent?: boolean;
}) {
  const groups = groupToolActivity(React.Children.toArray(children), (child) =>
    React.isValidElement<ActivityCall>(child) && child.type === Tool
      ? child.props
      : undefined,
  );
  return (
    <>
      {groups.map((group) =>
        group.kind === 'content' ? (
          group.item
        ) : group.calls.length === 1 ? (
          <Tool
            key={callKey(group.calls[0])}
            {...group.calls[0]}
            agent={showAgent ? group.calls[0].agent : undefined}
          />
        ) : (
          <ToolGroup
            key={`group:${callKey(group.calls.at(-1)!)}`}
            calls={group.calls}
            showAgent={showAgent}
          />
        ),
      )}
    </>
  );
}
