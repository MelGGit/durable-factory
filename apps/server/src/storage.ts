import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  defineDoc,
  Harness,
  createRegistry,
  type JsonObject,
  type HarnessOptions,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  ApiError,
  defaultSettings,
  type Settings,
} from '../../../packages/shared/src/index.js';

export const context = BACKGROUND_CONTEXT;
export const Configuration = defineDoc({
  kind: 'factory.configuration',
  scope: 'session',
  version: 1,
  initial: () => ({
    schemaVersion: 1,
    revision: 0,
    settings: defaultSettings() as unknown as JsonObject,
  }),
  checkpointWhen: () => true,
});
export async function openConfiguration(
  dataDir: string,
  options?: HarnessOptions,
) {
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(dataDir, 'factory.sqlite')),
    options ?? { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const existing = await harness.snapshot(Configuration, context);
    if (existing && existing.schemaVersion !== 1)
      throw new Error('Unsupported schema');
    await harness.commit(async (tx) => {
      const config = await tx.doc(Configuration);
      const settings = config.settings as unknown as Settings;
      settings.commitIdentity ??= { name: '', email: '' };
    }, context);
  } catch {
    await harness.close(context);
    throw new ApiError(
      'NOT_READY',
      'Cannot read the application schema. Use a compatible app version or restore a compatible backup; settings have not been overwritten.',
      503,
    );
  }
  return {
    harness,
    async read() {
      const doc = (await harness.snapshot(Configuration, context))!;
      if (doc.schemaVersion !== 1)
        throw new ApiError(
          'NOT_READY',
          'Unsupported application schema. Upgrade the application before writing settings.',
          503,
        );
      return {
        revision: doc.revision,
        settings: structuredClone(doc.settings) as unknown as Settings,
      };
    },
    async save(expectedRevision: number, settings: Settings) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(Configuration);
        if (doc.schemaVersion !== 1)
          throw new ApiError(
            'NOT_READY',
            'Unsupported application schema. Upgrade the application before writing settings.',
            503,
          );
        if (doc.revision !== expectedRevision)
          throw new ApiError(
            'CONFLICT',
            'Settings changed in another window. Reload settings before saving again.',
            409,
          );
        doc.settings = structuredClone(settings) as unknown as JsonObject;
        doc.revision += 1;
      }, context);
    },
    close: () => harness.close(context),
  };
}
