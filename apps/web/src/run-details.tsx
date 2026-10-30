import React from 'react';
import {
  ROLES,
  type RunInspection,
} from '../../../packages/shared/src/index.js';

const labels: Record<string, string> = {
  planning: 'Planning',
  development: 'Development',
  review: 'Review',
};
const number = (value: number) => value.toLocaleString();

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
