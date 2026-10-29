type Harness = Awaited<
  ReturnType<typeof import('../apps/server/src/storage.js').openConfiguration>
>['harness'];
import { context } from '../apps/server/src/storage.js';
import { readFile, writeFile } from 'node:fs/promises';
import { startService } from '../tests/helpers/credentials.js';
import {
  simulationAdapter,
  type StageResult,
} from '../apps/server/src/workflow.js';
import { planningFixture, FakeGitHub } from '../tests/fixtures/planning.js';
import { until } from '../tests/fixtures/chat.js';
const [dataDir, conversationId, scenario, phase, remotePath] =
  process.argv.slice(2);
const adapter = simulationAdapter();
const original = adapter.execute;
if (scenario === 'cancellation' && phase === 'crash') {
  adapter.cancel = async (run) => {
    const attempt = run.attempts.at(-1)!;
    const harness = (service.chat as unknown as { harness: Harness }).harness;
    await until(
      () => harness.getTask(Number(attempt.taskId) as never, context),
      (task) => task?.state.status === 'terminal',
    );
    process.send?.({
      type: 'boundary',
      run: await service.workflow.get(run.id),
      attempt,
    });
    return new Promise<boolean>(() => {});
  };
}
const remote = async () =>
  JSON.parse(await readFile(remotePath, 'utf8').catch(() => '[]')) as string[];
adapter.reconcile = async (run) => ({
  quiescent: true,
  ...((await remote()).includes(run.publication?.id ?? '')
    ? { publicationResult: `Simulated recovered PR ${run.publication!.id}` }
    : {}),
});
adapter.execute = async (run, attempt, signal) => {
  const hold = async () => {
    process.send?.({ type: 'boundary', run, attempt });
    return new Promise<StageResult>(() => {});
  };
  if (phase === 'crash') {
    if (scenario === 'cancellation' && attempt.stage === 'developer')
      return new Promise<StageResult>(() => {});
    if (scenario === 'boundary' && attempt.stage === 'checks') return hold();
    if (scenario === 'repair') {
      if (attempt.stage === 'checks' && run.repairCount === 0)
        return { outcome: 'failed', message: 'Injected validation failure' };
      if (attempt.stage === 'developer' && run.repairCount === 1) return hold();
    }
    if (scenario === 'question' && attempt.stage === 'developer')
      return { outcome: 'needs_input', message: 'Choose behavior' };
    if (scenario === 'publication' && attempt.stage === 'publishing') {
      const effects = await remote();
      effects.push(run.publication!.id);
      await writeFile(remotePath, JSON.stringify(effects));
      return hold();
    }
  }
  return original(run, attempt, signal);
};
const service = await startService({
  dataDir,
  port: 0,
  chat: planningFixture(),
  github: new FakeGitHub(),
  workflow: { adapter },
});
if (phase === 'crash') {
  const run = await service.workflow.admit({
    operationId: 'crash-start',
    conversationId,
  });
  if (scenario === 'cancellation') {
    const active = await until(
      () => service.workflow.get(run.id),
      (r) => r.stage === 'developer',
    );
    void service.workflow
      .command(run.id, {
        action: 'cancel',
        operationId: 'crash-cancel',
        expectedRevision: active.revision,
      })
      .catch(() => process.exit(1));
  }
  if (scenario === 'question')
    process.send?.({
      type: 'boundary',
      run: await until(
        () => service.workflow.get(run.id),
        (r) => r.status === 'needs_input',
      ),
    });
} else {
  const initial = (await service.workflow.snapshot()).runs[0];
  const run = await until(
    () => service.workflow.get(initial.id),
    (r) =>
      scenario === 'cancellation'
        ? r.status === 'cancelled'
        : scenario === 'question'
          ? r.status === 'needs_input'
          : r.status === 'pr_ready',
  );
  process.send?.({ type: 'recovered', run });
}
process.on('message', async (message) => {
  if (message === 'close') {
    await service.close();
    process.exit(0);
  }
});
