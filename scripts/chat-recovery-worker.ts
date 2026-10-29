import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startService } from '../tests/helpers/credentials.js';
import { fixture, configure, until } from '../apps/server/src/chat-fixtures.js';
import { ChatClient } from '../packages/shared/src/index.js';
const [dataDir, scenario, mode] = process.argv.slice(2);
const deps = fixture(mode === 'crash' && scenario === 'model' ? 30 : Infinity);
const original = deps.tools[0];
const chat = {
  ...deps,
  tools: [
    {
      ...original,
      replay: scenario === 'safe' ? ('safe' as const) : ('unsafe' as const),
      async execute(
        args: Parameters<typeof original.execute>[0],
        api: Parameters<typeof original.execute>[1],
        context: Parameters<typeof original.execute>[2],
      ) {
        await appendFile(join(dataDir, 'calls.txt'), 'called\n');
        if (scenario === 'unsafe')
          await appendFile(join(dataDir, 'effects.txt'), 'effect\n');
        api.output('Committed output before crash.\n');
        if (mode === 'crash') await new Promise<void>(() => {});
        return original.execute(args, api, context);
      },
    },
  ],
};
const service = await startService({ dataDir, port: 0, chat });
const client = new ChatClient(service.url);
let stop: (() => void) | undefined;
try {
  let conversation = (await client.conversations()).conversations[0];
  if (!conversation) {
    await configure(client);
    conversation = await client.createConversation(
      'Crash recovery',
      'create-recovery',
    );
  }
  const content =
    scenario === 'model' ? 'Long streamed question. '.repeat(25) : 'use tool';
  const submission = await client.submit(
    conversation.id,
    content,
    'stable-recovery-input',
  );
  if (mode === 'crash') {
    await client.submit(
      conversation.id,
      'Queued recovery follow-up',
      'stable-queued-input',
    );
    stop = client.watch(
      conversation.id,
      (snapshot) => {
        if (
          (scenario === 'model' && snapshot.partial) ||
          (scenario !== 'model' &&
            snapshot.tools.some((tool) =>
              tool.output?.includes('Committed output'),
            ))
        )
          process.send?.({ phase: 'crash', submissionId: submission.id });
      },
      () => {},
    );
    await new Promise(() => {});
  } else {
    await until(
      () => client.submission(conversation.id, 'stable-recovery-input'),
      (value) => value.status === 'completed',
    );
    await until(
      () => client.submission(conversation.id, 'stable-queued-input'),
      (value) => value.status === 'completed',
    );
    const history = await client.history(conversation.id);
    process.send?.({
      phase: 'done',
      submissionId: submission.id,
      entries: history.entries,
    });
  }
} finally {
  stop?.();
  await service.close();
}
