import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { realFixture } from '../tests/fixtures/real.js';
const scenario = process.argv[2];
let publicationReached!: () => void;
const publication = new Promise<void>((resolve) => {
  publicationReached = resolve;
});
const fixture = await realFixture(
  scenario === 'report'
    ? {
        afterImplementation: async () => {
          publicationReached();
          await new Promise(() => {});
        },
      }
    : scenario === 'proof'
      ? {
          regression: {
            required: true,
            command: 'node regression.test.cjs',
            testPaths: ['regression.test.cjs'],
            expectedFailure: 'REGRESSION',
          },
          proofTest: `const fs=require('node:fs');if(fs.readFileSync('value.txt','utf8')!=='implemented\\n'){console.error('REGRESSION');process.exit(1);}fs.mkdirSync('generated',{recursive:true});fs.writeFileSync('generated/proof-checkpoint','ready');setTimeout(()=>{},60000);`,
        }
      : scenario === 'command'
        ? { developerCommand: 'echo effect >> effect.txt; sleep 60' }
        : {
            afterCreate: async () => {
              publicationReached();
              await new Promise(() => {});
            },
          },
);
if (scenario === 'commit')
  await writeFile(
    join(fixture.repo, '.git/hooks/post-commit'),
    '#!/bin/sh\necho ready > generated/commit-checkpoint\nsleep 60\n',
    { mode: 0o700 },
  );
if (scenario === 'push')
  await writeFile(
    join(fixture.remote, 'hooks/post-receive'),
    '#!/bin/sh\necho ready > push-checkpoint\nsleep 60\n',
    { mode: 0o700 },
  );
const run = await fixture.client.startIssue(7, 'crash-start');
if (scenario === 'proof') {
  for (;;) {
    const current = await fixture.client.run(run.id);
    const candidate = current.proofWorkspaces?.find((p) =>
      p.id.endsWith('-candidate'),
    );
    if (candidate)
      try {
        if (
          (await readFile(
            join(candidate.root, 'generated/proof-checkpoint'),
            'utf8',
          )) === 'ready'
        )
          break;
      } catch {}
    await delay(20);
  }
} else if (['command', 'commit', 'push'].includes(scenario)) {
  for (;;) {
    const current = await fixture.client.run(run.id);
    if (current.workspace)
      try {
        if (
          (
            await readFile(
              scenario === 'push'
                ? join(fixture.remote, 'push-checkpoint')
                : join(
                    current.workspace.path,
                    scenario === 'commit'
                      ? 'generated/commit-checkpoint'
                      : 'effect.txt',
                  ),
              'utf8',
            )
          ).includes(scenario === 'command' ? 'effect' : 'ready')
        )
          break;
      } catch {}
    await delay(20);
  }
} else await publication;
process.send?.({ directory: fixture.directory, runId: run.id });
await new Promise(() => {});
