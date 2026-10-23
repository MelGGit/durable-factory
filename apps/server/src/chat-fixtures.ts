import { setTimeout as delay } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { ChatClient } from '../../../packages/shared/src/index.js';
export function fixture(tokensPerSecond = Infinity) {
  const faux = fauxProvider({
    provider: 'requesty',
    models: [{ id: 'offline', contextWindow: 32768 }],
    tokensPerSecond,
    tokenSize: { min: 1, max: 1 },
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 100 }, () => async (input) => {
      const last = [...input.messages]
        .reverse()
        .find((message) => message.role === 'user');
      const text =
        typeof last?.content === 'string'
          ? last.content
          : JSON.stringify(last?.content);
      if (
        text?.includes('use tool') &&
        !input.messages.some((message) => message.role === 'toolResult')
      )
        return fauxAssistantMessage(
          fauxToolCall(
            'probe',
            { command: 'controlled fixture' },
            { id: 'probe-call' },
          ),
          { stopReason: 'toolUse' },
        );
      return fauxAssistantMessage(`Offline reply: ${text}`);
    }),
  );
  const probe = defineTool({
    name: 'probe',
    description: 'Controlled fixture only',
    parameters: Type.Object({ command: Type.String() }),
    replay: 'safe',
    execute: async (args, api, context) => {
      api.output(`Running ${args.command}\n`);
      await delay(300, undefined, { signal: context.abortSignal });
      return { output: [{ type: 'text', text: 'Fixture complete.' }] };
    },
  });
  return { models, tools: [probe], faux };
}
export async function configure(client: ChatClient) {
  const saved = await client.settings();
  saved.settings.roles.planning = {
    provider: 'requesty',
    model: 'offline',
    reasoning: null,
  };
  saved.settings.roles.development = {
    provider: 'requesty',
    model: 'offline',
    reasoning: null,
  };
  saved.settings.roles.review = {
    provider: 'requesty',
    model: 'offline',
    reasoning: null,
  };
  await client.saveSettings({
    expectedRevision: saved.revision,
    settings: saved.settings,
  });
}
export async function until<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 10000,
) {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`Condition did not settle: ${JSON.stringify(value)}`);
}

export { fauxAssistantMessage, fauxToolCall };
export { createRegistry } from '@earendil-works/pi-durable';
