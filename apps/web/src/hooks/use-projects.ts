import { useEffect, useState } from 'react';
import {
  DEFAULT_PROJECT_ID,
  FactoryClient,
  type ProjectSummary,
} from '../../../../packages/shared/src/index.js';

const client = new FactoryClient();

/** Polls the project list; `reloadProjects` refreshes it right away. */
export function useProjects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await client.projects();
        if (active) setProjects(result.projects);
      } catch {
        // Keep the last list; the default project still works without it.
      } finally {
        if (active) timer = setTimeout(load, 5000);
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [version]);
  const visibleProjects: ProjectSummary[] = projects.length
    ? projects
    : [
        {
          id: DEFAULT_PROJECT_ID,
          name: '',
          repository: { path: '', github: '', baseBranch: 'main' },
        },
      ];
  return {
    projects,
    visibleProjects,
    reloadProjects: () => setVersion((value) => value + 1),
  };
}
