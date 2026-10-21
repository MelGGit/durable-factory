import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
} from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import {
  stream,
  streamSimple,
} from '@earendil-works/pi-ai/api/openai-completions';
import type { Model } from '@earendil-works/pi-ai';
import type {
  PrivateCredentials,
  CredentialInspection,
} from './credentials.js';
import {
  PROVIDERS,
  type ProviderStatus,
} from '../../../packages/shared/src/index.js';

export function requestyModel(id: string): Model<'openai-completions'> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: 'requesty',
    baseUrl: 'https://router.requesty.ai/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}
export function createFactoryModels(
  credentials: PrivateCredentials,
  requestyIds: string[] = [],
) {
  // No ambient credentials: subscription selection must never turn into an API-key call.
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(
    createProvider({
      id: 'requesty',
      name: 'Requesty',
      baseUrl: 'https://router.requesty.ai/v1',
      models: [...new Set(requestyIds)].filter(Boolean).map(requestyModel),
      auth: {
        apiKey: {
          name: 'Requesty API key',
          resolve: async ({ credential }) =>
            credential?.key
              ? {
                  auth: { apiKey: credential.key },
                  source: 'stored credential',
                }
              : undefined,
        },
      },
      api: { stream, streamSimple },
    }),
  );
  return models;
}
export async function providerStatuses(
  credentials: PrivateCredentials,
  inspection?: CredentialInspection,
): Promise<ProviderStatus[]> {
  inspection ??= await credentials.inspect();
  const metadata = inspection;
  const models = createFactoryModels(credentials);
  return PROVIDERS.map((id) => ({
    id,
    configured: metadata.configured[id],
    status: metadata.errors[id]
      ? 'error'
      : metadata.configured[id]
        ? 'configured'
        : 'not_configured',
    // Catalog capabilities stay available even when one credential is unreadable.
    models: models.getModels(id).map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: [...getSupportedThinkingLevels(model)],
    })),
    message:
      metadata.errors[id] ??
      (id === 'requesty'
        ? 'Enter an exact Requesty model ID. Availability depends on your account.'
        : 'Model catalog capabilities; availability depends on your account.'),
  }));
}
