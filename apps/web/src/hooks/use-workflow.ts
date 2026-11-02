import { useEffect, useState } from 'react';
import {
  WorkflowClient,
  type ConversationSummary,
  type DeletionOperation,
  type WorkflowSnapshot,
} from '../../../../packages/shared/src/index.js';

const workflowClient = new WorkflowClient();

/** Follows runs, pending deletions and conversations over one stream. Keep
 * it to one: the browser allows few connections per origin, shared by tabs,
 * and the selected chat needs its own. */
export function useWorkflow() {
  const [workflowSnapshot, setWorkflowSnapshot] = useState<WorkflowSnapshot>();
  const [deletions, setDeletions] = useState<DeletionOperation[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [connected, setConnected] = useState(false);
  const [streamError, setStreamError] = useState('');
  useEffect(
    () =>
      workflowClient.watchProject(
        (state) => {
          setWorkflowSnapshot(state.snapshot);
          setDeletions(state.deletions);
          setConversations(state.conversations);
        },
        setConnected,
        (error) => setStreamError(error.message),
      ),
    [],
  );
  return {
    workflowSnapshot,
    setWorkflowSnapshot,
    deletions,
    setDeletions,
    conversations,
    setConversations,
    connected,
    streamError,
  };
}
