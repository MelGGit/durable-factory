import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  WorkflowRun,
  StageAttempt,
  RegressionEvidence,
} from '../../../packages/shared/src/index.js';
import { Workspaces, git } from './workspace.js';
import { ProcessSupervisor } from './processes.js';

type Resource = NonNullable<WorkflowRun['proofWorkspaces']>[number];
/** All execution goes through the existing supervisor. Snapshot ownership is durable before creation. */
export async function regressionProof(
  run: WorkflowRun,
  attempt: StageAttempt,
  signal: AbortSignal,
  workspaces: Workspaces,
  processes: ProcessSupervisor,
  dataDir: string,
  persist: (change: (run: WorkflowRun) => void) => Promise<void>,
): Promise<RegressionEvidence> {
  const proof = run.specification.regression;
  if (!proof?.required) throw new Error('No approved regression requirement.');
  // A previous interrupted proof is never silently overwritten or replayed.
  for (const resource of run.proofWorkspaces ?? []) {
    if (resource.state === 'removed') continue;
    await workspaces.cleanupProofWorkspace(run, resource);
    await persist((r) => {
      r.proofWorkspaces!.find((p) => p.id === resource.id)!.state = 'removed';
    });
  }
  await workspaces.cleanupProofIndexes(run);
  const root = workspaces.path(run);
  const index = join(
    dataDir,
    'proofs',
    `${run.id}-${attempt.id}-${attempt.taskId}.index`,
  );
  await persist((r) => {
    r.proofIndexes ??= [];
    if (!r.proofIndexes.includes(index)) r.proofIndexes.push(index);
  });
  await mkdir(join(dataDir, 'proofs'), { recursive: true, mode: 0o700 });
  const env = {
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'Durable Factory',
    GIT_AUTHOR_EMAIL: 'proof@localhost',
    GIT_COMMITTER_NAME: 'Durable Factory',
    GIT_COMMITTER_EMAIL: 'proof@localhost',
  };
  let baseTree: string;
  try {
    await git(root, ['read-tree', run.base], env);
    for (const path of proof.testPaths) {
      const entry = (
        await git(root, [
          'ls-tree',
          '-z',
          run.source,
          '--',
          `:(literal)${path}`,
        ])
      )
        .split('\0')
        .filter(Boolean);
      if (entry.length !== 1)
        throw new Error(`Approved proof file is missing: ${path}.`);
      const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entry[0]);
      if (!match || match[3] !== path)
        throw new Error(
          'Proof paths must be regular files, never directories or symlinks.',
        );
      await git(
        root,
        [
          'update-index',
          '--add',
          '--cacheinfo',
          `${match[1]},${match[2]},${path}`,
        ],
        env,
      );
    }
    baseTree = (await git(root, ['write-tree'], env)).trim();
  } finally {
    await rm(index, { force: true });
    await rm(index + '.lock', { force: true });
  }
  const resources: Resource[] = [];
  const results: RegressionEvidence['results'] = [];
  const execute = async (
    resource: Resource,
    command: string,
    key: string,
    setup: boolean,
  ) => {
    const result = await processes.run({
      id: `${run.id}-${attempt.id}-${attempt.taskId}-proof-${key}`,
      runId: run.id,
      attemptId: attempt.id,
      cwd: resource.root,
      command,
      timeout: setup
        ? run.configuration.timeouts.setup
        : run.configuration.timeouts.check,
      cancellation: run.configuration.timeouts.cancellation,
      signal,
    });
    const recorded = {
      command,
      exitCode: result.exitCode ?? -1,
      duration: result.finishedAt! - result.startedAt,
      artifact: result.id,
    };
    results.push(recorded);
    await persist((r) => {
      const resourceRecord = r.proofWorkspaces!.find(
        (p) => p.id === resource.id,
      )!;
      resourceRecord.results ??= [];
      resourceRecord.results.push(recorded);
    });
    if (result.interrupted || result.exitCode === undefined)
      throw new Error(
        'Regression command was interrupted or timed out; inspect before continuing.',
      );
    return result;
  };
  for (const [lane, tree] of [
    ['base', baseTree],
    ['candidate', run.source],
  ] as const) {
    const commit = (
      await git(
        root,
        [
          'commit-tree',
          tree,
          '-p',
          run.base,
          '-m',
          'Durable Factory regression snapshot',
        ],
        env,
      )
    ).trim();
    const id = `${run.id}-${attempt.id}-${attempt.taskId}-${lane}`;
    const resource: Resource = {
      id,
      root: join(dataDir, 'proofs', id),
      commit,
      base: run.base,
      source: run.source,
      state: 'prepared',
    };
    await persist((r) => {
      r.proofWorkspaces ??= [];
      r.proofWorkspaces.push(structuredClone(resource));
    });
    resources.push(resource);
    signal.throwIfAborted();
    await workspaces.command(
      run,
      attempt,
      `proof-create-${lane}`,
      ['worktree', 'add', '--detach', resource.root, commit],
      signal,
      run.repository.path,
    );
    await persist((r) => {
      r.proofWorkspaces!.find((p) => p.id === id)!.state = 'ready';
    });
    for (const [i, command] of run.configuration.setupCommands.entries()) {
      const result = await execute(
        resource,
        command,
        `${lane}-setup-${i}`,
        true,
      );
      if (result.exitCode !== 0)
        throw new Error(
          `Regression ${lane} setup failed; it is not regression proof.`,
        );
    }
  }
  for (const resource of resources)
    if (
      (await workspaces.candidate(run, resource.root)) !==
      (
        await git(resource.root, ['rev-parse', `${resource.commit}^{tree}`])
      ).trim()
    )
      throw new Error(
        'Regression setup changed snapshot source; it is not valid proof.',
      );
  const base = await execute(resources[0], proof.command, 'base-test', false);
  const candidate = await execute(
    resources[1],
    proof.command,
    'candidate-test',
    false,
  );
  for (const resource of resources)
    if (
      (await workspaces.candidate(run, resource.root)) !==
      (
        await git(resource.root, ['rev-parse', `${resource.commit}^{tree}`])
      ).trim()
    )
      throw new Error(
        'Regression command changed snapshot source; it is not valid proof.',
      );
  const output = await processes.output(base);
  const passed =
    base.exitCode !== 0 &&
    output.includes(proof.expectedFailure) &&
    candidate.exitCode === 0;
  // Capture the final inventory only after quiescent, successful command completion.
  for (const resource of resources) {
    const inventory = await workspaces.fileInventory(
      resource.root,
      true,
      signal,
    );
    resource.inventory = inventory;
    await persist((r) => {
      r.proofWorkspaces!.find((p) => p.id === resource.id)!.inventory =
        inventory;
    });
    if (!(await processes.quiescent(run.id)))
      throw new Error('Regression processes are not quiescent.');
    await workspaces.cleanupProofWorkspace(run, resource);
    await persist((r) => {
      r.proofWorkspaces!.find((p) => p.id === resource.id)!.state = 'removed';
    });
  }
  return {
    base: run.base,
    source: run.source,
    configurationRevision: run.configurationRevision,
    specificationRevision: run.specificationRevision,
    passed,
    message: passed
      ? 'Regression demonstrated: approved test fails on the base with the expected signature and passes on the candidate.'
      : `Regression not demonstrated: base exit ${base.exitCode}, expected signature ${output.includes(proof.expectedFailure) ? 'found' : 'missing'}, candidate exit ${candidate.exitCode}.`,
    results,
  };
}
