import {
  projectLabel,
  type ConversationSnapshot,
  type ProjectSummary,
  type WorkflowRun,
} from '../../../../packages/shared/src/index.js';
import type { Route } from './use-route.js';

export type PageHeaderState = { title: string; tag?: string };

/** The title shown in the top bar, and the mode tag for conversations. */
export function usePageHeader({
  route,
  projects,
  snapshot,
  selectedRun,
  hasSelection,
}: {
  route: Route;
  projects: ProjectSummary[];
  snapshot?: ConversationSnapshot;
  selectedRun?: WorkflowRun;
  hasSelection: boolean;
}): PageHeaderState {
  if (route.kind === 'settings') return { title: 'Settings' };
  if (route.kind === 'add-project') return { title: 'Add project' };
  if (route.kind === 'project-settings') {
    const project = projects.find((item) => item.id === route.projectId);
    return {
      title: `${project ? projectLabel(project) : 'Project'} settings`,
    };
  }
  const role = snapshot?.conversation.role;
  if (selectedRun)
    return {
      title: selectedRun.specification.title,
      tag: role === 'review' ? 'Review' : 'Implementation',
    };
  if (hasSelection && snapshot)
    return {
      title: snapshot.conversation.title,
      tag:
        role === 'development'
          ? 'Implementation'
          : role === 'review'
            ? 'Review'
            : 'Planning',
    };
  return { title: hasSelection ? '' : 'Home' };
}
