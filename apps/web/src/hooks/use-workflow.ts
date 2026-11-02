import { useEffect, useState } from 'react';
import {
  EventHub,
  WorkflowClient,
  type ConversationSummary,
  type DeletionOperation,
  type WorkflowSnapshot,
} from '../../../../packages/shared/src/index.js';

const workflowClient = new WorkflowClient();
/** The tab's one long-lived connection. The browser allows few per origin,
 * shared by tabs, so the open chat and run activity are carried on it too. */
export const eventHub = new EventHub(workflowClient);

/** Follows runs, pending deletions and conversations over the hub's stream. */
export function useWorkflow() {
  const [workflowSnapshot, setWorkflowSnapshot] = useState<WorkflowSnapshot>();
  const [deletions, setDeletions] = useState<DeletionOperation[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [connected, setConnected] = useState(false);
  const [streamError, setStreamError] = useState('');
  useEffect(
    () =>
      eventHub.watch(
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
