import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { lstat, realpath, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Harness } from '@earendil-works/pi-durable';
import type { WorkflowRun } from '../../../packages/shared/src/index.js';
import { Deletions, issueDeletionKey } from './deletion-state.js';
import { Workflow, occupiedSlots } from './workflow.js';
import { Catalog } from './chat.js';
import { Processes } from './processes.js';
import { AgentOperations } from './real-workflow.js';
import { context } from './storage.js';
import { git, type Workspaces } from './workspace.js';

const require = createRequire(import.meta.url);

/** Capture materialized session documents before closing Pi. No database writes while Pi is open. */
export async function cleanupSnapshot(
  harness: Harness,
  run?: WorkflowRun,
  options: { preservePlanning?: boolean; conversationId?: string } = {},
) {
  await harness.commit(async (tx) => {
    await tx.doc(Workflow);
    await tx.doc(Catalog);
    const deletions = await tx.doc(Deletions);
    if (run && options.preservePlanning) {
      // Also cover deletion requests saved by versions without suppression metadata.
      deletions.suppressedIssues ??= {};
      deletions.suppressedIssues[
        issueDeletionKey(run.repository, run.issue.number)
      ] = true;
    }
  }, context);
  const workflow = structuredClone(
    (await harness.snapshot(Workflow, context))!,
  );
  const catalog = structuredClone((await harness.snapshot(Catalog, context))!);
  const processes = structuredClone(
    (await harness.snapshot(Processes, context)) ?? { records: {} },
  );
  const operations = structuredClone(
    (await harness.snapshot(AgentOperations, context)) ?? { items: {} },
  );
  for (const [id, operation] of Object.entries(operations.items))
    if (run && operation.runId === run.id) delete operations.items[id];
  if (run && occupiedSlots(workflow).includes(run.id))
    throw new Error('Run still owns execution.');
  const conversations = new Set([
    ...(options.conversationId ? [options.conversationId] : []),
    ...(run
      ? [
          run.developerConversationId,
          ...run.attempts.map((a) => a.conversationId),
        ]
      : []),
    ...Object.values(catalog.items)
      .filter((c) => run && c.runId === run.id)
      .map((c) => c.id),
  ]);
  if (
    !options.preservePlanning &&
    run?.planningConversationId &&
    !Object.values(workflow.runs).some(
      (r) =>
        r.id !== run.id &&
        r.planningConversationId === run.planningConversationId,
    )
  )
    conversations.add(run.planningConversationId);
  conversations.delete('');
  if (run) delete workflow.runs[run.id];
  if (options.conversationId)
    for (const retained of Object.values(workflow.runs))
      if (retained.planningConversationId === options.conversationId)
        retained.planningConversationId = '';
  (workflow as { revision: number }).revision++;
  for (const [id, receipt] of Object.entries(workflow.receipts))
    if (run && receipt.runId === run.id) delete workflow.receipts[id];
  for (const id of conversations) delete catalog.items[id];
  const commands = Object.values(processes.records)
    .filter((p) => run && p.runId === run.id)
    .map((p) => p.id);
  for (const id of commands) delete processes.records[id];
  return {
    conversations: [...conversations],
    commands,
    documents: {
      'factory.deletions': structuredClone(
        (await harness.snapshot(Deletions, context))!,
      ),
      'factory.workflow': workflow,
      'factory.conversations': catalog,
      'factory.processes': processes,
      'factory.agent-operations': operations,
    },
  };
}
export type CleanupSnapshot = Awaited<ReturnType<typeof cleanupSnapshot>>;

/** Pi Durable 1.3.0 / SQLite schema 1 only. Caller must hold ownership and close the harness. */
export function purgeRunStorage(
  dataDir: string,
  snapshot: CleanupSnapshot,
  prepareOnly = false,
) {
  if (require('@earendil-works/pi-durable/package.json').version !== '1.3.0')
    throw new Error('Unsupported Pi storage version for cleanup.');
  const db = new DatabaseSync(join(dataDir, 'factory.sqlite'));
  try {
    db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
    if (
      (
        db
          .prepare('SELECT version FROM durable_schema WHERE singleton=1')
          .get() as { version: number }
      )?.version !== 1
    )
      throw new Error('Unsupported Pi SQLite schema for cleanup.');
    if (snapshot.documents['factory.workflow'].schemaVersion !== 1)
      throw new Error('Unsupported application document version.');
    for (const kind of Object.keys(snapshot.documents)) {
      const rows = db
        .prepare(
          "SELECT d.id, r.version FROM documents d JOIN document_revisions r ON r.document_id=d.id WHERE d.kind=? AND d.scope_kind='session'",
        )
        .all(JSON.stringify(kind)) as { id: number; version: number }[];
      if (
        rows.some((r) => r.version !== 1) ||
        (kind === 'factory.workflow' && !rows.length)
      )
        throw new Error('Unsupported application document version.');
    }
    // Expand ownership transitively, including nested tool conversations/tasks.
    const ids = new Set(
      snapshot.conversations.map((id) => {
        if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))
          throw new Error('Invalid cleanup conversation.');
        return Number(id);
      }),
    );
    const tasks = new Set<number>();
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const row of db
        .prepare('SELECT id, conversation_id FROM tasks')
        .all() as { id: number; conversation_id: number }[])
        if (ids.has(row.conversation_id)) tasks.add(row.id);
      for (const row of db
        .prepare(
          'SELECT id, owner_conversation_id, owner_task_id FROM conversations',
        )
        .all() as {
        id: number;
        owner_conversation_id: number;
        owner_task_id: number;
      }[])
        if (
          !ids.has(row.id) &&
          (ids.has(row.owner_conversation_id) || tasks.has(row.owner_task_id))
        ) {
          ids.add(row.id);
          expanded = true;
        }
    }
    if (prepareOnly) {
      db.exec('ROLLBACK');
      return [...ids].map(String);
    }
    db.exec(
      'CREATE TEMP TABLE cleanup_conversations (id INTEGER PRIMARY KEY); CREATE TEMP TABLE cleanup_tasks (id INTEGER PRIMARY KEY); CREATE TEMP TABLE cleanup_documents (id INTEGER PRIMARY KEY)',
    );
    for (const id of ids)
      db.prepare('INSERT INTO cleanup_conversations VALUES (?)').run(id);
    for (const id of tasks)
      db.prepare('INSERT INTO cleanup_tasks VALUES (?)').run(id);
    db.exec(`INSERT INTO cleanup_documents SELECT id FROM documents WHERE
      (scope_kind='conversation' AND owner_id IN (SELECT id FROM cleanup_conversations)) OR
      (scope_kind='task' AND owner_id IN (SELECT id FROM cleanup_tasks));
      DELETE FROM record_ids WHERE id IN (SELECT id FROM entries WHERE conversation_id IN (SELECT id FROM cleanup_conversations))
        OR id IN (SELECT id FROM submissions WHERE conversation_id IN (SELECT id FROM cleanup_conversations))
        OR id IN (SELECT id FROM cleanup_tasks) OR id IN (SELECT id FROM cleanup_documents) OR id IN (SELECT id FROM cleanup_conversations);
      DELETE FROM document_revisions WHERE document_id IN (SELECT id FROM cleanup_documents);
      DELETE FROM documents WHERE id IN (SELECT id FROM cleanup_documents);
      DELETE FROM entries WHERE conversation_id IN (SELECT id FROM cleanup_conversations);
      DELETE FROM submissions WHERE conversation_id IN (SELECT id FROM cleanup_conversations);
      DELETE FROM tasks WHERE id IN (SELECT id FROM cleanup_tasks);
      DELETE FROM conversations WHERE id IN (SELECT id FROM cleanup_conversations);`);
    // Session documents retain history. Replace *all* their old bases/deltas with a
    // materialized checkpoint so deleted run payloads cannot survive in revisions.
    for (const [kind, value] of Object.entries(snapshot.documents)) {
      for (const row of db
        .prepare(
          "SELECT id FROM documents WHERE kind=? AND scope_kind='session'",
        )
        .all(JSON.stringify(kind)) as { id: number }[]) {
        const latest = db
          .prepare(
            'SELECT seq, version FROM document_revisions WHERE document_id=? ORDER BY seq DESC LIMIT 1',
          )
          .get(row.id) as { seq: number; version: number } | undefined;
        if (!latest) continue;
        if (latest.version !== 1)
          throw new Error('Unsupported application document version.');
        db.prepare('DELETE FROM document_revisions WHERE document_id=?').run(
          row.id,
        );
        db.prepare(
          "INSERT INTO document_revisions VALUES (?, ?, 'base', ?, ?)",
        ).run(row.id, latest.seq, latest.version, JSON.stringify(value));
      }
    }
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
    return [...ids].map(String);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/** Automatic cleanup preserves changed content; explicit manual deletion discards owned content. */
export async function cleanupWorkspace(
  dataDir: string,
  run: WorkflowRun,
  workspaces: Workspaces,
  discard = false,
) {
  if (!/^[A-Za-z0-9_-]+$/.test(run.id))
    throw new Error('Invalid run identity.');
  const directory = join(dataDir, 'worktrees');
  if ((await exists(directory)) && (await realpath(directory)) !== directory)
    throw new Error('Worktree ownership is uncertain.');
  await workspaces.cleanupProofIndexes(run);
  for (const resource of run.proofWorkspaces ?? [])
    await workspaces.cleanupProofWorkspace(run, resource, discard);
  if (!run.workspace) {
    if (!discard || run.mode !== 'real') return;
    // Setup may have created Git resources before its workspace receipt was saved.
    run = {
      ...run,
      workspace: {
        path: workspaces.path(run),
        branch: workspaces.branch(run),
        base: run.base,
        includedIgnored: [],
      },
    };
  }
  const workspace = run.workspace!;
  const expected = join(dataDir, 'worktrees', run.id);
  if (
    workspace.path !== expected ||
    workspace.branch !== workspaces.branch(run)
  )
    throw new Error('Worktree ownership is uncertain.');
  const branch = `refs/heads/${workspace.branch}`;
  const ref = `refs/durable-factory/${run.id}/base`;
  const base = (
    await git(run.repository.path, [
      'for-each-ref',
      '--format=%(objectname)',
      ref,
    ])
  ).trim();
  if (base && base !== workspace.base)
    throw new Error('Run base reference changed.');
  const listed = await git(run.repository.path, [
    'worktree',
    'list',
    '--porcelain',
  ]);
  if (await exists(expected)) {
    if (
      (await realpath(expected)) !== expected ||
      !listed.includes(`worktree ${expected}\n`)
    )
      throw new Error('Worktree ownership is uncertain.');
    const common = async (root: string) =>
      realpath(
        (
          await git(root, [
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
          ])
        ).trim(),
      );
    if ((await common(expected)) !== (await common(run.repository.path)))
      throw new Error('Worktree ownership is uncertain.');
    if (
      (await git(expected, ['symbolic-ref', '--short', 'HEAD'])).trim() !==
      workspace.branch
    )
      throw new Error('Worktree ownership is uncertain.');
    if (
      !discard &&
      ((await git(expected, ['symbolic-ref', '--short', 'HEAD'])).trim() !==
        workspace.branch ||
        (await git(expected, ['rev-parse', 'HEAD'])).trim() !==
          run.publication?.commit ||
        (await workspaces.candidate(run)) !== run.publication?.tree ||
        (
          await git(expected, [
            'status',
            '--porcelain',
            '--untracked-files=all',
          ])
        ).trim())
    )
      throw new Error('Worktree contains unexpected changes.');
    const ignored = discard
      ? undefined
      : await workspaces.ignoredInventory(run);
    const baseline = run.publication?.cleanupIgnored;
    if (
      !discard &&
      (baseline ? ignored!.digest !== baseline.digest : ignored!.files > 0)
    )
      throw new Error(
        baseline
          ? 'Ignored files changed after publication.'
          : 'Ignored files have no saved cleanup baseline. Preserve or remove them before cleanup.',
      );
    // Git also refuses tracked/untracked changes and locked/submodule worktrees.
    await git(run.repository.path, [
      'worktree',
      'remove',
      ...(discard ? ['--force'] : []),
      expected,
    ]);
  } else if (listed.includes(`worktree ${expected}\n`)) {
    throw new Error(
      'Worktree registration remains but its directory is missing.',
    );
  }
  const head = (
    await git(run.repository.path, [
      'for-each-ref',
      '--format=%(objectname)',
      branch,
    ])
  ).trim();
  if (head) {
    if (!discard && head !== run.publication?.commit)
      throw new Error('Local branch changed after publication.');
    if (
      (
        await git(run.repository.path, ['worktree', 'list', '--porcelain'])
      ).includes(`branch ${branch}\n`)
    )
      throw new Error('Local branch is in use.');
    await git(run.repository.path, ['update-ref', '-d', branch, head]);
  }
  if (base) {
    if (base !== workspace.base) throw new Error('Run base reference changed.');
    await git(run.repository.path, ['update-ref', '-d', ref, base]);
  }
  if (await exists(directory)) {
    if ((await realpath(directory)) !== directory)
      throw new Error('Worktree ownership is uncertain.');
    const indexPattern = new RegExp(
      `^\\.${run.id}-[a-f0-9-]{36}\\.index(?:\\.lock)?$`,
    );
    for (const name of await readdir(directory))
      if (indexPattern.test(name))
        await rm(join(directory, name), { force: true });
  }
}

export async function cleanupArtifacts(
  dataDir: string,
  snapshot: Pick<CleanupSnapshot, 'commands' | 'conversations'>,
) {
  const root = join(dataDir, 'artifacts');
  if (!(await exists(root))) return;
  if ((await realpath(root)) !== resolve(root))
    throw new Error('Artifact ownership is uncertain.');
  const commands = join(root, 'commands');
  if ((await exists(commands)) && (await realpath(commands)) !== commands)
    throw new Error('Command artifact ownership is uncertain.');
  for (const id of snapshot.conversations) {
    if (!/^[1-9][0-9]*$/.test(id))
      throw new Error('Invalid conversation artifact identity.');
    await rm(join(root, id), { recursive: true, force: true });
  }
  for (const id of snapshot.commands) {
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new Error('Invalid command artifact identity.');
    await rm(join(commands, `${id}.log`), { force: true });
  }
}
