import React, { useEffect, useState } from 'react';
import type { RunActivityItem } from '../../../packages/shared/src/index.js';
import { ActivityDisclosure } from './activity-disclosure.js';
import { workflowEventText } from './workflow-activity.js';
import { markdown } from './markdown.js';

function EventTime({ at }: { at?: number }) {
  return at === undefined ? null : (
    <time dateTime={new Date(at).toISOString()}>
      {new Date(at).toLocaleTimeString()}
    </time>
  );
}

/** Routine workflow progress stays subordinate to the agent conversation. */
export function WorkflowEvents({ items }: { items: RunActivityItem[] }) {
  const failures = items
    .filter((item) =>
      /\b(failed|blocked|uncertain|interrupted|error)\b/i.test(
        workflowEventText(item).title,
      ),
    )
    .map((item) => item.id)
    .join('\n');
  const [expanded, setExpanded] = useState(Boolean(failures));
  useEffect(() => {
    if (failures) setExpanded(true);
  }, [failures]);
  const first = items[0]!;
  const last = items.at(-1)!;
  const lastText = workflowEventText(last);
  if (items.length === 1 && !lastText.detail)
    return (
      <div className="workflow-event-row" data-conversation-item={first.id}>
        <span className="workflow-event-title">{lastText.title}</span>
        <span className="sr-only">
          <EventTime at={last.at} />
        </span>
      </div>
    );
  const title = `${lastText.title}${items.length > 1 ? ` · ${items.length} updates` : ''}`;
  return (
    <ActivityDisclosure
      className={`workflow-events${failures ? ' workflow-events-attention' : ''}`}
      data-conversation-item={first.id}
      open={expanded}
      onOpenChange={setExpanded}
    >
      <summary>
        <span className="tool-label" title={title}>
          {title}
        </span>
      </summary>
      <div className="workflow-event-list">
        {items.map((item) => {
          const event = workflowEventText(item);
          return (
            <div key={item.id} className="workflow-event-record">
              {items.length > 1 && (
                <div className="workflow-event-row">
                  <span>{event.title}</span>
                  <EventTime at={item.at} />
                </div>
              )}
              {items.length === 1 && (
                <div className="workflow-event-meta">
                  <EventTime at={item.at} />
                </div>
              )}
              {event.detail && (
                <div
                  className="workflow-event-detail markdown"
                  dangerouslySetInnerHTML={{ __html: markdown(event.detail) }}
                />
              )}
            </div>
          );
        })}
      </div>
    </ActivityDisclosure>
  );
}
