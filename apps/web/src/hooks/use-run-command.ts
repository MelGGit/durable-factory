import { useState } from 'react';
import {
  WorkflowClient,
  type WorkflowRun,
  type RunAction,
} from '../../../../packages/shared/src/index.js';

const client = new WorkflowClient();

export function useRunCommand(
  run: WorkflowRun,
  onRun: (run: WorkflowRun) => void,
  storageKey = `factory.runCommand.${run.id}`,
) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<
    | {
        key: string;
        id: string;
        revision: number;
      }
    | undefined
  >(() => {
    try {
      return (
        JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? undefined
      );
    } catch {
      return undefined;
    }
  });
  const act = async (action: RunAction, extra = {}) => {
    const key = JSON.stringify({ action, extra });
    const receipt =
      operation?.key === key
        ? operation
        : { key, id: crypto.randomUUID(), revision: run.revision };
    setOperation(receipt);
    try {
      localStorage.setItem(storageKey, JSON.stringify(receipt));
    } catch {
      /* Retain the in-memory receipt when browser storage is unavailable. */
    }
    setBusy(true);
    setError('');
    try {
      onRun(
        await client.command(run.id, {
          action,
          operationId: receipt.id,
          expectedRevision: receipt.revision,
          ...extra,
        }),
      );
      setOperation(undefined);
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* Already settled. */
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update run.');
      if (e instanceof Error && 'code' in e && e.code === 'CONFLICT') {
        setOperation(undefined);
        try {
          localStorage.removeItem(storageKey);
        } catch {
          /* Already settled. */
        }
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, busy, setBusy, act };
}
