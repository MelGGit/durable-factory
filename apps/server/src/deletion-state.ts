import type { JsonRepresentation } from '@earendil-works/chord';
import { defineDoc, type Tx } from '@earendil-works/pi-durable';
import { ApiError } from '../../../packages/shared/src/core.js';
import type { DeletionOperation } from '../../../packages/shared/src/deletion.js';

export const Deletions = defineDoc({
  kind: 'factory.deletions',
  scope: 'session',
  version: 1,
  initial: () => ({
    items: {} as Record<string, JsonRepresentation<DeletionOperation>>,
    suppressedIssues: {} as Record<string, boolean>,
  }),
  checkpointWhen: () => true,
});

export function deleting(
  state: { items: Record<string, DeletionOperation> } | undefined,
  conversationId?: string,
  runId?: string,
) {
  return Object.values(state?.items ?? {}).find(
    (operation) =>
      operation.state !== 'completed' &&
      ((runId && operation.runId === runId) ||
        (conversationId && operation.conversationIds.includes(conversationId))),
  );
}

export async function assertNotDeleting(
  tx: Tx,
  conversationId?: string,
  runId?: string,
) {
  if (deleting(await tx.doc(Deletions), conversationId, runId))
    throw new ApiError('CONFLICT', 'This chat is being deleted.', 409);
}

/** Include both repository identities so suppression cannot affect another checkout. */
export function issueDeletionKey(
  repository: { path: string; github: string },
  issue: number,
) {
  return JSON.stringify([repository.path, repository.github, issue]);
}
