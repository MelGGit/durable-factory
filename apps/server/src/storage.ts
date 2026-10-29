import { randomUUID } from 'node:crypto';
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
  DEFAULT_PROJECT_ID,
  defaultSettings,
  type ProjectSummary,
  type Settings,
  type TitleGeneratorSettings,
} from '../../../packages/shared/src/index.js';

export const context = BACKGROUND_CONTEXT;
export interface ProjectRecord {
  id: string;
  name: string;
  revision: number;
  settings: Settings;
}
const newProject = (
  id: string,
  name: string,
  settings = defaultSettings(),
): JsonObject => ({ id, name, revision: 0, settings }) as unknown as JsonObject;
export const Configuration = defineDoc({
  kind: 'factory.configuration',
  scope: 'session',
  version: 1,
  initial: () => ({
    schemaVersion: 1,
    projects: {
      [DEFAULT_PROJECT_ID]: newProject(DEFAULT_PROJECT_ID, ''),
    } as JsonObject,
    order: [DEFAULT_PROJECT_ID] as string[],
    /** How many runs may work at once, across all projects. */
    runners: 1,
    titleGenerator: { revision: 0, selection: null } as JsonObject,
  }),
  checkpointWhen: () => true,
});
/** The record for one project, or a 404 for an ID that was never created. */
export function projectOf(
  doc: { projects: unknown },
  projectId = DEFAULT_PROJECT_ID,
): ProjectRecord {
  const found = (doc.projects as Record<string, ProjectRecord>)[projectId];
  if (!found) throw new ApiError('NOT_FOUND', 'Project not found.', 404);
  return found;
}
/** Inside a transaction the document is a proxy that structuredClone rejects. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const summarize = (project: ProjectRecord): ProjectSummary => ({
  id: project.id,
  name: project.name,
  repository: copy(project.settings.repository),
});
const unsupported = () =>
  new ApiError(
    'NOT_READY',
    'Unsupported application schema. Upgrade the application before writing settings.',
    503,
  );
const cleanName = (name: unknown, allowEmpty = false) => {
  const value = typeof name === 'string' ? name.trim() : '';
  if ((!value && !allowEmpty) || value.length > 80)
    throw new ApiError(
      'INVALID_INPUT',
      'Enter a project name of 80 characters or fewer.',
      400,
    );
  return value;
};
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
      // A data directory written before projects existed held one set of
      // settings at the top level. They become the default project.
      const legacy = config as unknown as {
        settings?: Settings;
        revision?: number;
      };
      if (!config.projects) {
        config.projects = {
          [DEFAULT_PROJECT_ID]: {
            id: DEFAULT_PROJECT_ID,
            name: '',
            revision: legacy.revision ?? 0,
            settings: legacy.settings ?? defaultSettings(),
          },
        } as unknown as JsonObject;
        config.order = [DEFAULT_PROJECT_ID];
        delete legacy.settings;
        delete legacy.revision;
      }
      config.runners ??= 1;
      config.titleGenerator ??= { revision: 0, selection: null };
      for (const project of Object.values(
        config.projects as unknown as Record<string, ProjectRecord>,
      )) {
        project.settings.commitIdentity ??= { name: '', email: '' };
        // Projects are named for their folder until the user names them.
        if (project.name === 'Default project') project.name = '';
      }
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
    async read(projectId = DEFAULT_PROJECT_ID) {
      const doc = (await harness.snapshot(Configuration, context))!;
      if (doc.schemaVersion !== 1) throw unsupported();
      const project = projectOf(doc, projectId);
      return {
        projectId: project.id,
        name: project.name,
        revision: project.revision,
        settings: structuredClone(project.settings),
      };
    },
    async runners() {
      return (await harness.snapshot(Configuration, context))?.runners ?? 1;
    },
    async titleGenerator(): Promise<TitleGeneratorSettings> {
      return copy(
        (await harness.snapshot(Configuration, context))!.titleGenerator,
      ) as unknown as TitleGeneratorSettings;
    },
    async saveTitleGenerator(value: TitleGeneratorSettings) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(Configuration);
        if (doc.titleGenerator.revision !== value.revision)
          throw new ApiError(
            'CONFLICT',
            'Settings changed in another window. Reload settings before saving again.',
            409,
          );
        doc.titleGenerator = {
          revision: value.revision + 1,
          selection: copy(value.selection),
        } as unknown as JsonObject;
      }, context);
    },
    async setRunners(count: unknown) {
      if (
        !Number.isInteger(count) ||
        (count as number) < 1 ||
        (count as number) > 16
      )
        throw new ApiError(
          'INVALID_INPUT',
          'Parallel runs must be a whole number from 1 to 16.',
          400,
        );
      await harness.commit(async (tx) => {
        (await tx.doc(Configuration)).runners = count as number;
      }, context);
    },
    async projects(): Promise<ProjectSummary[]> {
      const doc = (await harness.snapshot(Configuration, context))!;
      if (doc.schemaVersion !== 1) throw unsupported();
      return (doc.order as string[]).map((id) => summarize(projectOf(doc, id)));
    },
    async save(
      expectedRevision: number,
      settings: Settings,
      projectId = DEFAULT_PROJECT_ID,
    ) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(Configuration);
        if (doc.schemaVersion !== 1) throw unsupported();
        const project = projectOf(doc, projectId);
        if (project.revision !== expectedRevision)
          throw new ApiError(
            'CONFLICT',
            'Settings changed in another window. Reload settings before saving again.',
            409,
          );
        project.settings = structuredClone(settings);
        project.revision += 1;
      }, context);
    },
    /** A new project starts with the agent models, identity and limits of an
     * existing one, so only the repository has to be filled in. */
    async create(name: string, copyFrom = DEFAULT_PROJECT_ID) {
      const clean = cleanName(name);
      return harness.commit(async (tx) => {
        const doc = await tx.doc(Configuration);
        if (doc.schemaVersion !== 1) throw unsupported();
        const projects = doc.projects as unknown as Record<
          string,
          ProjectRecord
        >;
        if (Object.values(projects).some((p) => p.name === clean))
          throw new ApiError(
            'CONFLICT',
            'A project with this name already exists.',
            409,
          );
        const settings = defaultSettings();
        const source = projects[copyFrom]?.settings;
        if (source) {
          settings.commitIdentity = copy(source.commitIdentity);
          settings.timeouts = copy(source.timeouts);
          settings.roles = copy(source.roles);
        }
        const id = `p-${randomUUID().slice(0, 8)}`;
        projects[id] = newProject(
          id,
          clean,
          settings,
        ) as unknown as ProjectRecord;
        (doc.order as string[]).push(id);
        return summarize(projects[id]);
      }, context);
    },
    async rename(projectId: string, name: string) {
      // An empty name goes back to the folder's name.
      const clean = cleanName(name, true);
      return harness.commit(async (tx) => {
        const doc = await tx.doc(Configuration);
        if (doc.schemaVersion !== 1) throw unsupported();
        const project = projectOf(doc, projectId);
        if (
          clean &&
          Object.values(
            doc.projects as unknown as Record<string, ProjectRecord>,
          ).some((p) => p.id !== projectId && p.name === clean)
        )
          throw new ApiError(
            'CONFLICT',
            'A project with this name already exists.',
            409,
          );
        project.name = clean;
        return summarize(project);
      }, context);
    },
    async remove(projectId: string) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(Configuration);
        if (doc.schemaVersion !== 1) throw unsupported();
        projectOf(doc, projectId);
        if ((doc.order as string[]).length === 1)
          throw new ApiError(
            'CONFLICT',
            'The last project cannot be deleted.',
            409,
          );
        delete (doc.projects as unknown as Record<string, unknown>)[projectId];
        const order = doc.order as string[];
        order.splice(order.indexOf(projectId), 1);
      }, context);
    },
    close: () => harness.close(context),
  };
}
