import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { realFixture } from '../tests/fixtures/real.js';
import { until } from '../tests/fixtures/chat.js';
import { context } from '../apps/server/src/storage.js';
import {
  cleanupSnapshot,
  cleanupWorkspace,
  cleanupArtifacts,
} from '../apps/server/src/cleanup.js';
import { Workspaces } from '../apps/server/src/workspace.js';
import { ProcessSupervisor } from '../apps/server/src/processes.js';
import { PrivateCredentials } from '../apps/server/src/credentials.js';

const fixture = await realFixture();
const started = await fixture.client.startIssue(7, 'cleanup-crash');
const run = await until(
  () => fixture.client.run(started.id),
  (r) => r.status === 'pr_ready',
  30000,
);
const harness = fixture.service.workflow['harness'];
await until(
  () => harness.inspect(context),
  (s) => !s.tasks.length,
);
await fixture.service.workflow.cleanupState(run.id, {
  state: 'pending',
  message: 'PR merged and issue closed. Cleanup pending.',
});
const snapshot = await cleanupSnapshot(harness, run);
const workspaces = new Workspaces(
  await realpath(fixture.dataDir),
  new ProcessSupervisor(harness, fixture.dataDir),
  new PrivateCredentials(fixture.dataDir),
);
// Preserve fake remote confirmations across the forced process death.
const pulls = await fixture.github.pulls('example/project', '', 1);
pulls.pulls[0].merged = true;
pulls.pulls[0].state = 'closed';
await writeFile(
  join(fixture.directory, 'fake-github.json'),
  JSON.stringify({ pulls: pulls.pulls, creates: fixture.creates }),
);
await fixture.service.close();
await cleanupWorkspace(await realpath(fixture.dataDir), run, workspaces);
if (process.argv[2] === 'artifacts')
  await cleanupArtifacts(await realpath(fixture.dataDir), snapshot);
process.send?.({ directory: fixture.directory, runId: run.id });
setInterval(() => {}, 1000);
