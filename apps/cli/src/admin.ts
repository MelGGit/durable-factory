import {
  ROLES,
  projectLabel,
  type CredentialId,
  type FactoryClient,
  type OAuthPrompt,
  type OAuthProvider,
  type OAuthSession,
  type ProjectSummary,
  type RoleSettings,
  type Settings,
  type SettingsResponse,
} from '../../../packages/shared/src/index.js';
import { EXIT, UsageError, type Deps, type Parsed } from './cli.js';

type Print = (value: unknown, text: string) => void;

const OAUTH: OAuthProvider[] = ['openai', 'anthropic'];
const KEYS: CredentialId[] = ['requesty', 'github'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The project a name, id or unique id prefix refers to. */
export async function findProject(client: FactoryClient, ref: string) {
  const { projects } = await client.projects();
  const lower = ref.toLowerCase();
  const matches = [
    projects.filter((item) => item.id === ref),
    projects.filter((item) => projectLabel(item).toLowerCase() === lower),
    projects.filter((item) => item.id.startsWith(ref)),
  ].find((found) => found.length);
  if (!matches) throw new UsageError(`No project "${ref}".`);
  if (matches.length > 1)
    throw new UsageError(
      `"${ref}" matches ${matches.length} projects. Use an id.`,
    );
  return matches[0];
}

const projectLine = (project: ProjectSummary) =>
  [
    project.id.padEnd(10),
    projectLabel(project),
    project.repository.github ? `  ${project.repository.github}` : '',
    project.missingPrerequisites?.length
      ? `  (needs: ${project.missingPrerequisites.join(', ')})`
      : '',
  ].join('');

export async function projects(
  deps: Deps,
  [sub = 'list', ...rest]: string[],
  flags: Parsed['flags'],
  print: Print,
) {
  const client = deps.workflow;
  switch (sub) {
    case 'list': {
      const { projects } = await client.projects();
      print(
        projects,
        projects
          .map(
            (item) =>
              `${item.id === client.projectId ? '*' : ' '} ${projectLine(item)}`,
          )
          .join('\n') || 'No projects.',
      );
      return EXIT.ok;
    }
    case 'add': {
      const name = rest.join(' ').trim();
      if (!name) throw new UsageError('Give the project a name.');
      const created = await client.createProject(name);
      print(
        created,
        `${projectLine(created)}\nSet its repository with: factory settings set repository.path=/path repository.github=owner/name --project ${created.id}`,
      );
      return EXIT.ok;
    }
    case 'rename': {
      const [ref, ...name] = rest;
      if (!ref || !name.length)
        throw new UsageError('Use: factory project rename <project> <name>');
      const target = await findProject(client, ref);
      const renamed = await client.renameProject(target.id, name.join(' '));
      print(renamed, projectLine(renamed));
      return EXIT.ok;
    }
    case 'remove':
    case 'rm': {
      if (!rest[0]) throw new UsageError('Name a project.');
      const target = await findProject(client, rest[0]);
      if (!flags.has('yes'))
        throw new UsageError(
          `This deletes project "${projectLabel(target)}" (${target.id}) and its settings. Repeat with --yes to confirm.`,
        );
      await client.deleteProject(target.id);
      print({ deleted: target.id }, `Deleted ${projectLabel(target)}.`);
      return EXIT.ok;
    }
    default:
      throw new UsageError(
        'Use: factory project list | add <name> | rename <project> <name> | remove <project> --yes',
      );
  }
}

export async function issues(deps: Deps, flags: Parsed['flags'], print: Print) {
  const raw = flags.get('page');
  const page = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(page) || page < 1)
    throw new UsageError('--page must be a whole number from 1.');
  const result = await deps.workflow.projectIssues(page);
  print(
    { page, ...result },
    [
      ...result.issues.map(
        (issue) => `#${String(issue.number).padEnd(5)} ${issue.title}`,
      ),
      result.hasNext ? `\nMore: factory issues --page ${page + 1}` : '',
    ]
      .join('\n')
      .trim() || 'No issues.',
  );
  return EXIT.ok;
}

const role = (name: string, value: RoleSettings) =>
  `  ${name.padEnd(12)}${value.provider ?? '-'} / ${value.model || '-'}${value.reasoning ? ` (${value.reasoning})` : ''}`;

function settingsText(response: SettingsResponse) {
  const { settings: s } = response;
  const configured = Object.entries(response.credentials)
    .map(([id, on]) => `${id}: ${on ? 'set' : 'not set'}`)
    .join(', ');
  return [
    `project   ${response.projectId}  ${response.name}  (revision ${response.revision})`,
    '',
    'repository',
    `  path        ${s.repository.path || '-'}`,
    `  github      ${s.repository.github || '-'}`,
    `  baseBranch  ${s.repository.baseBranch}`,
    'commit identity',
    `  name        ${s.commitIdentity.name || '-'}`,
    `  email       ${s.commitIdentity.email || '-'}`,
    `setupCommands  ${s.setupCommands.join(' ; ') || '-'}`,
    `requiredChecks ${s.requiredChecks.join(' ; ') || '-'}`,
    `timeouts (s)   ${Object.entries(s.timeouts)
      .map(([name, seconds]) => `${name} ${seconds}`)
      .join(', ')}`,
    'models',
    ...ROLES.map((name) => role(name, s.roles[name])),
    '',
    `credentials  ${configured}  (storage: ${response.credentialStorage.backend}, ${response.credentialStorage.status})`,
    ...Object.entries(response.credentialErrors).map(
      ([id, message]) => `  ${id}: ${message}`,
    ),
  ].join('\n');
}

/**
 * Applies `path=value` edits to a copy of the settings. Paths are the ones in
 * the JSON, such as `repository.github` or `roles.development.model`. A list
 * takes the value of each repeat in turn; an empty value clears it.
 */
export function applyEdits(settings: Settings, edits: string[]): Settings {
  const next = structuredClone(settings);
  const listed = new Set<string>();
  for (const edit of edits) {
    const at = edit.indexOf('=');
    if (at < 1) throw new UsageError(`"${edit}" is not path=value.`);
    const path = edit.slice(0, at);
    const value = edit.slice(at + 1);
    const keys = path.split('.');
    const last = keys.pop()!;
    let target: Record<string, unknown> = next as unknown as Record<
      string,
      unknown
    >;
    for (const key of keys) {
      const child = target[key];
      if (!child || typeof child !== 'object' || Array.isArray(child))
        throw new UsageError(
          `Unknown setting "${path}". See: factory settings`,
        );
      target = child as Record<string, unknown>;
    }
    if (!(last in target) || path === 'schemaVersion')
      throw new UsageError(`Unknown setting "${path}". See: factory settings`);
    const current = target[last];
    if (Array.isArray(current)) {
      target[last] = !value
        ? []
        : listed.has(path)
          ? [...current, value]
          : [value];
      listed.add(path);
    } else if (typeof current === 'number') {
      if (!value.trim() || !Number.isFinite(Number(value)))
        throw new UsageError(`${path} must be a number.`);
      target[last] = Number(value);
    } else if (current === null || last === 'provider' || last === 'reasoning')
      target[last] = value === '' || value === 'none' ? null : value;
    else if (typeof current === 'string') target[last] = value;
    else throw new UsageError(`"${path}" is not a single setting.`);
  }
  return next;
}

export async function settings(
  deps: Deps,
  [sub = 'show', ...rest]: string[],
  print: Print,
) {
  const client = deps.workflow;
  switch (sub) {
    case 'show': {
      const response = await client.settings();
      print(response, settingsText(response));
      return EXIT.ok;
    }
    case 'set': {
      if (!rest.length)
        throw new UsageError(
          'Use: factory settings set <path=value>...  e.g. repository.github=owner/name roles.development.model=gpt-5',
        );
      const current = await client.settings();
      const saved = await client.saveSettings({
        expectedRevision: current.revision,
        settings: applyEdits(current.settings, rest),
      });
      print(saved, settingsText(saved));
      return EXIT.ok;
    }
    case 'validate': {
      const result = await client.validateGitHub();
      print(result, result.message);
      return result.accessible ? EXIT.ok : EXIT.failed;
    }
    default:
      throw new UsageError(
        'Use: factory settings [show] | set <path=value>... | validate',
      );
  }
}

export async function providers(deps: Deps, print: Print) {
  const { providers } = await deps.workflow.providers();
  print(
    providers,
    providers
      .map(
        (item) =>
          `${item.id.padEnd(10)}${item.status}${item.message ? `  ${item.message}` : ''}\n` +
          item.models
            .map(
              (model) =>
                `    ${model.id}${model.reasoning.length ? `  [${model.reasoning.join(', ')}]` : ''}`,
            )
            .join('\n'),
      )
      .join('\n'),
  );
  return EXIT.ok;
}

const needAsk = (deps: Deps) => {
  if (!deps.ask) throw new UsageError('This needs a terminal to ask in.');
  return deps.ask;
};

export async function credential(
  deps: Deps,
  [sub, id, value]: (string | undefined)[],
  print: Print,
) {
  const client = deps.workflow;
  if (sub === 'retry-storage') {
    const { storage } = await client.retryCredentialStorage();
    print(storage, `${storage.backend}: ${storage.status}`);
    return storage.status === 'ready' ? EXIT.ok : EXIT.failed;
  }
  const known = [...KEYS, ...OAUTH] as string[];
  if ((sub !== 'set' && sub !== 'rm') || !id || !known.includes(id))
    throw new UsageError(
      'Use: factory credential set <requesty|github> [token] | rm <requesty|github|openai|anthropic> | retry-storage',
    );
  const provider = id as CredentialId;
  if (sub === 'rm') {
    await client.deleteCredential(provider);
    print({ [provider]: false }, `Removed the ${provider} credential.`);
    return EXIT.ok;
  }
  if (!KEYS.includes(provider))
    throw new UsageError(
      `${provider} uses a subscription sign-in. Run: factory login ${provider}`,
    );
  // A token on the command line stays in shell history; asking avoids that.
  const token = (
    value ?? (await needAsk(deps)(`${provider} token:`, true))
  ).trim();
  if (!token) throw new UsageError('Give a token.');
  await client.saveCredential(provider, token);
  print({ [provider]: true }, `Saved the ${provider} credential.`);
  return EXIT.ok;
}

export async function login(
  deps: Deps,
  provider: string | undefined,
  flags: Parsed['flags'],
  json: boolean,
  print: Print,
) {
  if (!provider || !OAUTH.includes(provider as OAuthProvider))
    throw new UsageError(`Use: factory login <${OAUTH.join('|')}>`);
  const id = provider as OAuthProvider;
  const client = deps.workflow;
  const seconds =
    typeof flags.get('timeout') === 'string'
      ? Number(flags.get('timeout'))
      : 300;
  if (!(seconds > 0))
    throw new UsageError('--timeout must be a number of seconds.');
  // Instructions go to stderr under --json so stdout stays one document.
  const tell = (text: string) => (json ? deps.io.err(text) : deps.io.out(text));
  let session: OAuthSession | null = (await client.startLogin(id)).session;
  const told = new Set<string>();
  const answered = new Set<string>();
  const deadline = Date.now() + seconds * 1000;
  while (session?.state === 'pending') {
    if (session.authUrl && !told.has('url')) {
      told.add('url');
      tell(`Open this address to sign in:\n  ${session.authUrl}`);
    }
    if (session.deviceCode && !told.has('code')) {
      told.add('code');
      tell(
        `Go to ${session.deviceCode.verificationUri} and enter ${session.deviceCode.userCode}`,
      );
    }
    const prompt: OAuthPrompt | undefined = session.prompt;
    if (prompt && !answered.has(prompt.id)) {
      answered.add(prompt.id);
      const ask = needAsk(deps);
      let answer: string;
      if (prompt.type === 'select' && prompt.options) {
        tell(
          [
            prompt.message,
            ...prompt.options.map(
              (option, index) => `  ${index + 1}. ${option.label}`,
            ),
          ].join('\n'),
        );
        const picked = (await ask('Choose a number:', false)).trim();
        const option =
          prompt.options[Number(picked) - 1] ??
          prompt.options.find((item) => item.id === picked);
        if (!option) throw new UsageError(`"${picked}" is not an option.`);
        answer = option.id;
      } else answer = await ask(`${prompt.message}`, prompt.type === 'secret');
      session = (await client.answerLogin(id, session.id, prompt.id, answer))
        .session;
      continue;
    }
    if (Date.now() >= deadline) {
      await client.cancelLogin(id, session.id).catch(() => {});
      throw new Error(`Sign-in timed out after ${seconds} seconds.`);
    }
    await sleep(deps.pollMs ?? 1000);
    session = (await client.loginStatus(id)).session;
  }
  if (session?.state !== 'completed')
    throw new Error(
      session?.error?.message ?? `Sign-in ${session?.state ?? 'ended'}.`,
    );
  print(session, `Signed in to ${id}.`);
  return EXIT.ok;
}

export async function runners(
  deps: Deps,
  count: string | undefined,
  print: Print,
) {
  if (count !== undefined) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1)
      throw new UsageError('Runners must be a whole number from 1.');
    const saved = await deps.workflow.saveRunners(n);
    print(saved, `${saved.runners} runner${saved.runners === 1 ? '' : 's'}.`);
    return EXIT.ok;
  }
  const { runners } = await deps.workflow.runners();
  print({ runners }, `${runners} runner${runners === 1 ? '' : 's'}.`);
  return EXIT.ok;
}

const selectionText = (selection: RoleSettings | null) =>
  selection
    ? `${selection.provider ?? '-'} / ${selection.model}${selection.reasoning ? ` (${selection.reasoning})` : ''}`
    : 'Not set; titles come from the planning model.';

export async function titles(
  deps: Deps,
  [sub = 'show', provider, model, reasoning]: string[],
  print: Print,
) {
  const client = deps.workflow;
  const current = await client.titleGenerator();
  if (sub === 'show') {
    print(current, selectionText(current.selection));
    return EXIT.ok;
  }
  if (sub !== 'set' && sub !== 'clear')
    throw new UsageError(
      'Use: factory titles [show] | set <provider> <model> [reasoning] | clear',
    );
  if (sub === 'set' && (!provider || !model))
    throw new UsageError('Give a provider and a model.');
  const saved = await client.saveTitleGenerator({
    revision: current.revision,
    selection:
      sub === 'clear'
        ? null
        : {
            provider: provider as RoleSettings['provider'],
            model,
            reasoning: reasoning ?? null,
          },
  });
  print(saved, selectionText(saved.selection));
  return EXIT.ok;
}

export async function deletions(deps: Deps, print: Print) {
  const { operations } = await deps.chat.deletions();
  print(
    operations,
    operations
      .map((item) => {
        const op = item as unknown as Record<string, unknown>;
        return `${op.id}  ${op.state ?? ''}  ${op.kind ?? ''}`.trimEnd();
      })
      .join('\n') || 'No deletions in progress.',
  );
  return EXIT.ok;
}
