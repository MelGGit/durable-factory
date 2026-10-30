import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChatClient,
  WorkflowClient,
  type ProjectIssueSummary,
  type ProjectSummary,
  type WorkflowRun,
  type WorkflowSnapshot,
} from '../../../packages/shared/src/index.js';

type IssueAction = 'start' | 'edit';

export function ProjectIssues({
  project,
  runs,
  mode,
  onRun,
  onOpen,
}: {
  project: ProjectSummary;
  runs: WorkflowRun[];
  mode: WorkflowSnapshot['mode'];
  onRun: (run: WorkflowRun) => void;
  onOpen: (conversationId: string) => void;
}) {
  const client = useMemo(
    () => new ChatClient(undefined, undefined, project.id),
    [project.id],
  );
  const workflow = useMemo(
    () => new WorkflowClient(undefined, undefined, project.id),
    [project.id],
  );
  const [issues, setIssues] = useState<ProjectIssueSummary[]>([]);
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<{ number: number; action: IssueAction }>();
  const request = useRef<AbortController | undefined>(undefined);
  const receipts = useRef(new Map<string, string>());
  const repository = project.repository.github;
  const load = useCallback(
    async (nextPage = 1) => {
      request.current?.abort();
      const abort = new AbortController();
      request.current = abort;
      setLoading(true);
      setError('');
      try {
        const result = await client.projectIssues(nextPage, abort.signal);
        if (abort.signal.aborted) return;
        setIssues((previous) =>
          nextPage === 1
            ? result.issues
            : [
                ...new Map(
                  [...previous, ...result.issues].map((issue) => [
                    issue.number,
                    issue,
                  ]),
                ).values(),
              ],
        );
        setPage(nextPage);
        setHasNext(result.hasNext);
      } catch (error) {
        if (!abort.signal.aborted)
          setError(
            error instanceof Error ? error.message : 'Could not load issues.',
          );
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    },
    [client, repository],
  );
  useEffect(() => {
    setIssues([]);
    setPage(0);
    setHasNext(false);
    if (repository) void load();
    return () => request.current?.abort();
  }, [repository, load]);
  const act = async (issue: ProjectIssueSummary, action: IssueAction) => {
    if (busy) return;
    const existing = runs.findLast(
      (run) =>
        run.projectId === project.id &&
        run.repository.github === repository &&
        run.issue.number === issue.number,
    );
    if (action === 'start' && existing) {
      onOpen(existing.developerConversationId);
      return;
    }
    const key = `factory.home.issue.${action}.${project.id}.${repository}.${issue.number}`;
    let id = receipts.current.get(key) ?? crypto.randomUUID();
    try {
      id = localStorage.getItem(key) ?? id;
      localStorage.setItem(key, id);
    } catch {
      /* Keep the receipt in memory if storage is unavailable. */
    }
    receipts.current.set(key, id);
    setBusy({ number: issue.number, action });
    setError('');
    try {
      const result =
        action === 'start'
          ? await workflow.startIssue(issue.number, id)
          : await client.planIssue(issue.number, id);
      try {
        localStorage.removeItem(key);
      } catch {
        /* The request has already settled. */
      }
      receipts.current.delete(key);
      if (action === 'start') onRun(result as WorkflowRun);
      else onOpen(result.id);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not open this issue.',
      );
    } finally {
      setBusy(undefined);
    }
  };
  if (!repository)
    return (
      <p className="home-issues-empty">
        Add a GitHub repository in project settings to see its issues.
      </p>
    );
  return (
    <div className="home-project-issues" aria-busy={loading}>
      <div className="home-issues-heading">
        <h4>Open issues</h4>
        <button
          type="button"
          className="text-button"
          disabled={loading || Boolean(busy)}
          onClick={() => void load()}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {loading && page === 0 && (
        <p className="home-issues-empty" role="status">
          Loading issues…
        </p>
      )}
      {error && (
        <p className="home-issues-error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && page > 0 && !issues.length && !hasNext && (
        <p className="home-issues-empty">No open issues.</p>
      )}
      {issues.length > 0 && (
        <ul className="home-issues">
          {issues.map((issue) => {
            const existing = runs.findLast(
              (run) =>
                run.projectId === project.id &&
                run.repository.github === repository &&
                run.issue.number === issue.number,
            );
            return (
              <li key={issue.number}>
                <a
                  className="home-issue-title"
                  href={issue.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>#{issue.number}</span>
                  <strong>{issue.title}</strong>
                </a>
                <div className="home-issue-actions">
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Edit issue #${issue.number}`}
                    disabled={Boolean(busy)}
                    onClick={() => void act(issue, 'edit')}
                  >
                    {busy?.number === issue.number && busy.action === 'edit'
                      ? 'Opening…'
                      : 'Edit issue'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`${existing ? 'Open implementation for' : mode === 'simulation' ? 'Start simulated run for' : 'Start implementation of'} issue #${issue.number}`}
                    disabled={
                      Boolean(busy) || (!existing && mode === 'disabled')
                    }
                    onClick={() => void act(issue, 'start')}
                  >
                    {busy?.number === issue.number && busy.action === 'start'
                      ? 'Starting…'
                      : existing
                        ? 'Open implementation'
                        : mode === 'simulation'
                          ? 'Start simulated run'
                          : 'Start implementation'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hasNext && (
        <button
          type="button"
          className="text-button home-issues-more"
          disabled={loading || Boolean(busy)}
          onClick={() => void load(page + 1)}
        >
          Load more issues
        </button>
      )}
    </div>
  );
}
