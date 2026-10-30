import React from 'react';
import {
  ROLES,
  type RunInspection,
  type WorkflowRun,
} from '../../../packages/shared/src/index.js';

const labels: Record<string, string> = {
  planning: 'Planning',
  development: 'Development',
  review: 'Review',
  requesty: 'Requesty',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};
const number = (value: number) => value.toLocaleString();

export function RunModels({ run }: { run: WorkflowRun }) {
  return (
    <div className="run-models">
      {ROLES.map((role) => {
        const model = run.configuration.roles[role];
        return (
          <section
            className="run-model"
            key={role}
            aria-label={`${labels[role]} model`}
          >
            <h3>{labels[role]}</h3>
            <strong>{model.model || 'Not configured'}</strong>
            <span className="run-detail-note">
              {model.provider ? labels[model.provider] : 'No provider selected'}
              {model.reasoning && ` · Reasoning: ${model.reasoning}`}
            </span>
          </section>
        );
      })}
    </div>
  );
}

export function RunUsage({
  inspection,
  error,
}: {
  inspection?: RunInspection;
  error: string;
}) {
  const conversations = inspection?.conversations ?? [];
  const reported = conversations.filter(
    (conversation) => conversation.usage.messages > 0,
  );
  const totals = reported.reduce(
    (sum, { usage }) => ({
      input: sum.input + usage.input,
      output: sum.output + usage.output,
      cacheRead: sum.cacheRead + usage.cacheRead,
      cacheWrite: sum.cacheWrite + usage.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const estimates = reported.flatMap(({ usage }) =>
    usage.estimatedCost === undefined ? [] : [usage.estimatedCost],
  );
  return (
    <div className="run-usage">
      {error && (
        <p className="run-detail-note" role="status">
          {error}
        </p>
      )}
      {!reported.length ? (
        <p className="run-detail-note">
          {inspection
            ? 'No token usage reported yet.'
            : error
              ? 'Token usage unavailable.'
              : 'Loading usage…'}
        </p>
      ) : (
        <>
          <h3>Reported tokens</h3>
          <dl className="run-usage-metrics" aria-label="Reported tokens">
            {(
              [
                ['Input', totals.input],
                ['Output', totals.output],
                ['Cache read', totals.cacheRead],
                ['Cache write', totals.cacheWrite],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{number(value)}</dd>
              </div>
            ))}
          </dl>
          <dl className="run-detail-list" aria-label="Usage by role">
            {ROLES.map((role) => {
              const usage = reported.filter(
                (conversation) => conversation.role === role,
              );
              if (!usage.length) return null;
              return (
                <div key={role}>
                  <dt>{labels[role]}</dt>
                  <dd>
                    {number(
                      usage.reduce(
                        (sum, conversation) => sum + conversation.usage.input,
                        0,
                      ),
                    )}{' '}
                    in
                    {' · '}
                    {number(
                      usage.reduce(
                        (sum, conversation) => sum + conversation.usage.output,
                        0,
                      ),
                    )}{' '}
                    out
                  </dd>
                </div>
              );
            })}
            <div>
              <dt>Estimated cost (USD)</dt>
              <dd>
                {estimates.length
                  ? `$${estimates.reduce((sum, cost) => sum + cost, 0).toFixed(4)}`
                  : 'Not available'}
              </dd>
            </div>
          </dl>
          {(reported.some(({ usage }) => usage.partial) ||
            reported.length < conversations.length) && (
            <p className="run-detail-note">
              Partial usage; some history or token counts are unavailable.
            </p>
          )}
          {estimates.length > 0 && estimates.length < reported.length && (
            <p className="run-detail-note">
              Cost includes available estimates only.
            </p>
          )}
        </>
      )}
      <p className="run-detail-note">
        Subscription tokens do not represent per-token billing.
      </p>
    </div>
  );
}

function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes
    ? `${minutes} min${remainder ? ` ${remainder} s` : ''}`
    : `${seconds} s`;
}

export function RunConfiguration({ run }: { run: WorkflowRun }) {
  return (
    <div className="run-configuration">
      <dl className="run-detail-list">
        <div>
          <dt>Revision</dt>
          <dd>{run.configurationRevision}</dd>
        </div>
        <div>
          <dt>Repairs used</dt>
          <dd>
            {run.repairCount} of {run.repairLimit}
          </dd>
        </div>
      </dl>
      {(
        [
          ['Setup commands', run.configuration.setupCommands],
          ['Required checks', run.configuration.requiredChecks],
        ] as const
      ).map(([title, commands]) => (
        <section key={title}>
          <h3>{title}</h3>
          {commands.length ? (
            <ol className="run-config-commands">
              {commands.map((command, index) => (
                <li key={index}>
                  <code>{command}</code>
                </li>
              ))}
            </ol>
          ) : (
            <p className="run-detail-note">None configured.</p>
          )}
        </section>
      ))}
      <section>
        <h3>Timeouts</h3>
        <dl className="run-detail-list">
          {(
            [
              ['Setup', 'setup'],
              ['Tool calls', 'tool'],
              ['Checks', 'check'],
              ['Model response', 'provider'],
              ['Cancellation', 'cancellation'],
            ] as const
          ).map(([label, key]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{duration(run.configuration.timeouts[key])}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
