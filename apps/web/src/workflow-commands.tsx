import React, { useEffect, useState } from 'react';
import type { RunActivityItem } from '../../../packages/shared/src/index.js';
import { CommandLog } from './runs.js';
import { ActivityDisclosure } from './activity-disclosure.js';

function commandLabel(command: string) {
  const labels: [string, string][] = [
    ['git fetch ', 'Fetch repository'],
    ['git update-ref ', 'Update base reference'],
    ['git worktree add ', 'Create worktree'],
    ['git worktree remove ', 'Remove worktree'],
    ['git status', 'Check working tree'],
    ['git diff', 'Inspect changes'],
    ['git add ', 'Stage changes'],
    ['git commit ', 'Commit changes'],
    ['git push ', 'Push branch'],
  ];
  return (
    labels.find(
      ([prefix]) => command === prefix || command.startsWith(prefix),
    )?.[1] ?? command
  );
}

function commandStatus(item: RunActivityItem) {
  const command = item.command!;
  if (command.state === 'uncertain')
    return { tone: 'warning', label: 'Status unknown', attention: true };
  if (item.detail?.includes('Interrupted'))
    return { tone: 'warning', label: 'Interrupted', attention: true };
  if (command.state === 'finished') {
    if (command.exitCode === 0)
      return { tone: 'success', label: 'Succeeded', attention: false };
    if (command.exitCode !== undefined)
      return {
        tone: 'failed',
        label: `Failed · Exit ${command.exitCode}`,
        attention: true,
      };
    return {
      tone: 'warning',
      label: 'Finished · Exit unknown',
      attention: true,
    };
  }
  return {
    tone: 'running',
    label: command.state === 'prepared' ? 'Preparing' : 'Running',
    attention: false,
  };
}

export function WorkflowCommands({
  items,
  runId,
}: {
  items: RunActivityItem[];
  runId: string;
}) {
  const statuses = items.map(commandStatus);
  const attention = statuses.some((status) => status.attention);
  const running = items.some(
    (item) =>
      item.command!.state !== 'finished' && item.command!.state !== 'uncertain',
  );
  const [expanded, setExpanded] = useState(attention || running);
  useEffect(() => {
    if (attention || running) setExpanded(true);
  }, [attention, running]);
  const failed = statuses.filter((status) => status.tone === 'failed').length;
  const warning = statuses.filter((status) => status.tone === 'warning').length;
  const tone = failed
    ? 'failed'
    : warning
      ? 'warning'
      : running
        ? 'running'
        : 'success';
  const label = `${running ? 'Running' : 'Ran'} ${items.length} command${items.length === 1 ? '' : 's'}`;
  return (
    <ActivityDisclosure
      className={`workflow-commands command-group-${tone}`}
      data-conversation-item={items[0]!.id}
      open={expanded}
      onOpenChange={setExpanded}
    >
      <summary className="command-group-summary">
        <span className="command-group-title">{label}</span>
        <span
          className={`${tone === 'success' ? 'sr-only' : 'command-status'} command-status-${tone}`}
        >
          {failed
            ? `${failed} failed`
            : warning
              ? 'Needs attention'
              : running
                ? 'In progress'
                : 'Succeeded'}
        </span>
      </summary>
      <div className="command-list">
        {items.map((item, index) => {
          const status = statuses[index]!;
          return (
            <div
              key={item.id}
              className="workflow-command"
              data-conversation-item={item.id}
            >
              <CommandLog
                runId={runId}
                commandId={item.command!.id}
                command={item.title}
                visible={expanded}
                running={
                  item.command!.state !== 'finished' &&
                  item.command!.state !== 'uncertain'
                }
                attention={status.attention}
                summary={
                  <>
                    <span className="command-label" title={item.title}>
                      {commandLabel(item.title)}
                    </span>
                    <span
                      className={`command-status command-status-${status.tone}`}
                    >
                      {status.label}
                    </span>
                    {item.at !== undefined && (
                      <time dateTime={new Date(item.at).toISOString()}>
                        {new Date(item.at).toLocaleTimeString()}
                      </time>
                    )}
                  </>
                }
              />
            </div>
          );
        })}
      </div>
    </ActivityDisclosure>
  );
}
