import React from 'react';
import { ActivityDisclosure } from './activity-disclosure.js';
import { markdown } from './markdown.js';
import {
  ArtifactText,
  useCachedState,
  Tool,
  ToolActivity,
  ToolActivityProvider,
} from './tool-activity.js';
import {
  groupResponseFlow,
  type ActivityCall,
  type ResponseSpeaker,
} from './transcript.js';
import type {
  TranscriptEntry,
  TranscriptPart,
} from '../../../packages/shared/src/index.js';

type PartProps = {
  speaker?: ResponseSpeaker;
  attemptId?: string;
  at?: number;
  closes?: boolean;
  children: React.ReactNode;
};

/** A presentation marker. The flow consumes its metadata without adding a box. */
export function ResponsePart({ children }: PartProps) {
  return <>{children}</>;
}

function Thinking({
  part,
  conversationId,
  active,
}: {
  part: Extract<TranscriptPart, { text: string }>;
  conversationId: string;
  active: boolean;
}) {
  const [open, setOpen] = useCachedState(
    JSON.stringify(['thinking', conversationId, part.id]),
    false,
  );
  const preview = part.text
    .split('\n')
    .find((line) => line.trim())
    ?.replace(/^\s*(?:#{1,6}\s+|[-*>]\s+)/, '')
    .replace(/[*_`]/g, '')
    .trim();
  return (
    <ActivityDisclosure
      className="thinking-activity"
      data-thinking-id={part.id}
      open={open}
      onOpenChange={setOpen}
    >
      <summary>
        {active && <span className="tool-indicator" aria-hidden="true" />}
        <span className="thinking-label">
          {active ? 'Thinking…' : 'Thinking'}
        </span>
        <span className="thinking-preview">{preview}</span>
      </summary>
      <div className="thinking-content">
        <div
          className="markdown"
          dangerouslySetInnerHTML={{ __html: markdown(part.text) }}
        />
        {part.artifact && (
          <ArtifactText
            conversationId={conversationId}
            artifact={part.artifact}
            label="thinking"
          />
        )}
      </div>
    </ActivityDisclosure>
  );
}

export function ResponseText({
  entry,
  conversationId,
  itemKey,
  live = false,
}: {
  entry: TranscriptEntry;
  conversationId: string;
  itemKey: string;
  live?: boolean;
}) {
  return (
    <div
      className="message assistant-message response-text"
      data-conversation-item={itemKey}
    >
      {entry.interrupted && <p className="response-note">Interrupted</p>}
      {entry.parts
        ? entry.parts.map((part, index) =>
            part.type === 'thinking' ? (
              <Thinking
                key={part.id}
                part={part}
                conversationId={conversationId}
                active={live && index === entry.parts!.length - 1}
              />
            ) : part.type === 'text' ? (
              <React.Fragment key={part.id}>
                <div
                  className="message-text markdown"
                  dangerouslySetInnerHTML={{ __html: markdown(part.text) }}
                />
                {part.artifact && (
                  <ArtifactText
                    conversationId={conversationId}
                    artifact={part.artifact}
                    label="response"
                  />
                )}
              </React.Fragment>
            ) : null,
          )
        : entry.text && (
            <div
              className="message-text markdown"
              dangerouslySetInnerHTML={{ __html: markdown(entry.text) }}
            />
          )}
      {!entry.parts && entry.textArtifact && (
        <Tool
          conversationId={conversationId}
          tool={{
            id: entry.id,
            name: 'Complete message',
            status: 'completed',
            artifact: entry.textArtifact,
          }}
        />
      )}
    </div>
  );
}

export function ResponseFlow({ children }: { children: React.ReactNode }) {
  const nodes = React.Children.toArray(children);
  const blocks = groupResponseFlow(nodes, (node) => {
    if (React.isValidElement<PartProps>(node) && node.type === ResponsePart) {
      return node.props.speaker
        ? {
            kind: 'agent',
            speaker: node.props.speaker,
            at: node.props.at,
            closes: node.props.closes,
          }
        : { kind: 'workflow', attemptId: node.props.attemptId };
    }
    if (React.isValidElement<ActivityCall>(node) && node.type === Tool)
      return {
        kind: 'agent',
        speaker: {
          conversationId: node.props.conversationId,
          attemptId: node.props.attemptId,
          author: node.props.agent ?? 'Planning agent',
        },
        at: node.props.at,
      };
    return { kind: 'boundary' };
  });
  const unwrap = (node: React.ReactNode) => {
    if (!React.isValidElement<PartProps>(node) || node.type !== ResponsePart)
      return node;
    const child = node.props.children;
    return React.isValidElement(child)
      ? React.cloneElement(child, { key: node.key })
      : child;
  };
  const nodeKey = (node: React.ReactNode, index: number) =>
    React.isValidElement(node) ? (node.key ?? index) : index;
  return (
    <ToolActivityProvider>
      {blocks.map((block, index) =>
        block.kind === 'standalone' ? (
          <React.Fragment key={`standalone:${nodeKey(block.item, index)}`}>
            {unwrap(block.item)}
          </React.Fragment>
        ) : (
          <section
            className="agent-response"
            key={`response:${nodeKey(block.items[0], index)}`}
            data-response-agent={block.speaker.author}
            data-response-conversation={block.speaker.conversationId}
          >
            <div className="message-author response-author">
              <span>{block.speaker.author}</span>
              {block.at !== undefined && (
                <time dateTime={new Date(block.at).toISOString()}>
                  {new Date(block.at).toLocaleTimeString()}
                </time>
              )}
            </div>
            <div className="response-content">
              <ToolActivity showAgent={false}>
                {block.items.map(unwrap)}
              </ToolActivity>
            </div>
          </section>
        ),
      )}
    </ToolActivityProvider>
  );
}
