import {
  ApiError,
  PROVIDERS,
  ROLES,
  type Settings,
  type TitleGeneratorSettings,
} from '../../../packages/shared/src/index.js';
import { providerStatuses } from './providers.js';
import type { PrivateCredentials } from './credentials.js';
import { validateRepository } from './runtime.js';
function invalid(message: string): never {
  throw new ApiError('INVALID_INPUT', message, 400);
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('Expected a settings object.');
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in result))
  )
    invalid('Settings fields do not match this API version.');
  return result;
}
function text(value: unknown, max = 4096): value is string {
  return (
    typeof value === 'string' && value.length <= max && !value.includes('\0')
  );
}
export async function validateTitleGenerator(
  input: unknown,
  credentials: PrivateCredentials,
): Promise<TitleGeneratorSettings> {
  const value = object(input, ['revision', 'selection']);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)
    invalid('A valid title generator revision is required.');
  if (value.selection !== null) {
    const selection = object(value.selection, [
      'provider',
      'model',
      'reasoning',
    ]);
    if (
      !PROVIDERS.includes(selection.provider as (typeof PROVIDERS)[number]) ||
      !text(selection.model, 200) ||
      !selection.model ||
      /\s/.test(selection.model)
    )
      invalid(
        'Choose a title provider and model, or disable title generation.',
      );
    const provider = (await providerStatuses(credentials)).find(
      (p) => p.id === selection.provider,
    );
    const model = provider?.models.find((m) => m.id === selection.model);
    if (selection.provider !== 'requesty' && !model)
      invalid('Choose a model from the provider catalog.');
    if (
      selection.reasoning !== null &&
      (typeof selection.reasoning !== 'string' ||
        !model?.reasoning.includes(selection.reasoning))
    )
      invalid('The selected reasoning setting is not supported by this model.');
  }
  return structuredClone(value) as unknown as TitleGeneratorSettings;
}
export async function validateSettings(
  input: unknown,
  dataDir: string,
  credentials: PrivateCredentials,
): Promise<Settings> {
  const s = object(input, [
    'schemaVersion',
    'repository',
    'commitIdentity',
    'setupCommands',
    'requiredChecks',
    'timeouts',
    'roles',
  ]);
  const identity = object(s.commitIdentity, ['name', 'email']);
  if (
    !Object.values(identity).every(
      (value) => text(value, 200) && !/[\r\n<>]/.test(value as string),
    )
  )
    invalid(
      'Commit identity must contain a name and email without line breaks or angle brackets.',
    );
  if (identity.email && !/^[^\s@]+@[^\s@]+$/.test(identity.email as string))
    invalid('Enter a valid commit email.');
  if (s.schemaVersion !== 1) invalid('Unsupported settings schema version.');
  const repository = object(s.repository, ['path', 'github', 'baseBranch']);
  if (!Object.values(repository).every((value) => text(value)))
    invalid('Repository fields must be text.');
  if (
    repository.github &&
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.github as string)
  )
    invalid('GitHub repository must use owner/repository format.');
  const branch = repository.baseBranch as string;
  if (
    !branch ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    /[\s~^:?*\[\\]|\.\.|@\{|\/\//.test(branch) ||
    branch
      .split('/')
      .some((part) => part.startsWith('.') || part.endsWith('.lock'))
  )
    invalid('Enter a valid base branch name.');
  await validateRepository(repository.path as string, dataDir);
  for (const key of ['setupCommands', 'requiredChecks']) {
    const commands = s[key];
    if (
      !Array.isArray(commands) ||
      commands.length > 50 ||
      !commands.every((command) => text(command) && command.trim())
    )
      invalid('Commands must be a list of non-empty lines (at most 50).');
  }
  const timeouts = object(s.timeouts, [
    'setup',
    'tool',
    'check',
    'provider',
    'cancellation',
  ]);
  if (
    !Object.values(timeouts).every(
      (value) =>
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 86400,
    )
  )
    invalid('Timeouts must be whole seconds from 1 to 86400.');
  const roles = object(s.roles, [...ROLES]);
  const statuses = await providerStatuses(credentials);
  for (const role of ROLES) {
    const settings = object(roles[role], ['provider', 'model', 'reasoning']);
    if (
      settings.provider !== null &&
      !PROVIDERS.includes(settings.provider as (typeof PROVIDERS)[number])
    )
      invalid('Unknown model provider.');
    if (!text(settings.model, 200) || !/^\S*$/.test(settings.model))
      invalid('Model ID must be text without whitespace.');
    if (settings.reasoning !== null && !text(settings.reasoning, 30))
      invalid('Invalid reasoning selection.');
    if (!settings.provider && (settings.model || settings.reasoning !== null))
      invalid('Select a provider before a model.');
    if (settings.reasoning !== null) {
      const model = statuses
        .find((item) => item.id === settings.provider)
        ?.models.find((item) => item.id === settings.model);
      if (!model?.reasoning.includes(settings.reasoning as string))
        invalid(
          'The selected reasoning setting is not supported by this model.',
        );
    }
    if (
      settings.provider &&
      settings.provider !== 'requesty' &&
      settings.model &&
      !statuses
        .find((item) => item.id === settings.provider)
        ?.models.some((item) => item.id === settings.model)
    )
      invalid('Choose a model from the provider catalog.');
  }
  return structuredClone(input) as Settings;
}
export function parseUpdate(body: unknown) {
  const value = object(body, ['expectedRevision', 'settings']);
  if (
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0
  )
    invalid('A valid expected settings revision is required.');
  return {
    expectedRevision: value.expectedRevision as number,
    settings: value.settings,
  };
}
