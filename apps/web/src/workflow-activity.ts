import type { RunActivityItem } from '../../../packages/shared/src/index.js';
import type { PresentationTool } from './transcript.js';

export function isWorkflowEvent(item: RunActivityItem) {
  return (
    !item.command &&
    item.actor === 'code' &&
    !item.id.startsWith('timeline:question-') &&
    (!item.entry ||
      (item.entry.kind === 'factory.workflow' &&
        !item.entry.tools.length &&
        !item.entry.interrupted &&
        !item.entry.textArtifact))
  );
}

/** Process records for agent commands repeat the call and its output artifact.
 * Hide them only while that exact task's tool is available in the loaded view. */
export function groupWorkflowActivity(
  items: RunActivityItem[],
  tools: readonly PresentationTool[] = [],
) {
  const artifacts = new Set(
    tools.flatMap((tool) => (tool.artifact ? [tool.artifact] : [])),
  );
  const groups: RunActivityItem[][] = [];
  for (const item of items) {
    const task = item.command && /-tool-(\d+)$/.exec(item.command.id)?.[1];
    if (task && artifacts.has(`task-${task}`)) continue;
    const previous = groups.at(-1)?.[0];
    if (
      previous &&
      ((item.command &&
        previous.command &&
        item.attemptId === previous.attemptId) ||
        (isWorkflowEvent(item) && isWorkflowEvent(previous)))
    )
      groups.at(-1)!.push(item);
    else groups.push([item]);
  }
  return groups;
}

export function workflowEventText(item: RunActivityItem) {
  if (item.entry)
    return {
      title: item.entry.text.split('\n')[0] || item.title,
      detail: item.entry.text.includes('\n') ? item.entry.text : undefined,
    };
  return { title: item.title, detail: item.detail };
}
