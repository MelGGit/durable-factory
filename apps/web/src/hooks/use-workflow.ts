import { useEffect, useState } from 'react';
import {
  AgUiChatClient,
  WorkflowClient,
  type DeletionOperation,
  type WorkflowSnapshot,
} from '../../../../packages/shared/src/index.js';

const client = new AgUiChatClient();
const workflowClient = new WorkflowClient();

/** Polls runs and pending deletions once a second. */
export function useWorkflow() {
  const [workflowSnapshot, setWorkflowSnapshot] = useState<WorkflowSnapshot>();
  const [deletions, setDeletions] = useState<DeletionOperation[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Keep the browser's persistent connections available for the selected chat
    // and its controls, including when several tabs share this origin.
    const refreshRuns = async () => {
      try {
        const [value, deletionList] = await Promise.all([
          workflowClient.workflow(abort.signal),
          client.deletions(),
        ]);
        if (!abort.signal.aborted) {
          setWorkflowSnapshot(value);
          setDeletions(deletionList.operations);
        }
      } catch {
        // Retain the last navigation snapshot and retry after transient outages.
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(refreshRuns, 1000);
      }
    };
    void refreshRuns();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, []);
  return { workflowSnapshot, setWorkflowSnapshot, deletions, setDeletions };
}
