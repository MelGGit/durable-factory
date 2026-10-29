import {
  projectLabel,
  type ConversationSnapshot,
  type ProjectSummary,
  type WorkflowRun,
} from '../../../../packages/shared/src/index.js';
import type { Route } from './use-route.js';

export type PageHeaderState = { title: string; tag?: string };

/** The title shown in the top bar. */
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
  if (selectedRun)
    return {
      title: selectedRun.specification.title,
    };
  if (hasSelection && snapshot)
    return {
      title: snapshot.conversation.title,
      tag: snapshot.conversation.role === 'planning' ? 'Planning' : undefined,
    };
  return { title: hasSelection ? '' : 'Home' };
}
