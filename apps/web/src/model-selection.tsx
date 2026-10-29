import React from 'react';
import type {
  ProviderStatus,
  ProviderId,
  RoleSettings,
} from '../../../packages/shared/src/index.js';

export function ModelSelection({
  selection,
  providers,
  onChange,
}: {
  selection: RoleSettings | null;
  providers: ProviderStatus[];
  onChange: (selection: RoleSettings | null) => void;
}) {
  const provider = providers.find((p) => p.id === selection?.provider);
  const model = provider?.models.find((m) => m.id === selection?.model);
  return (
    <div className="title-model-fields">
      <label>
        Title provider
        <select
          value={selection?.provider ?? ''}
          onChange={(event) =>
            onChange(
              event.target.value
                ? {
                    provider: event.target.value as ProviderId,
                    model: '',
                    reasoning: null,
                  }
                : null,
            )
          }
        >
          <option value="">Use first message</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {
                {
                  requesty: 'Requesty',
                  openai: 'OpenAI',
                  anthropic: 'Anthropic',
                }[p.id]
              }
            </option>
          ))}
        </select>
      </label>
      <label>
        Title model
        {selection?.provider === 'requesty' ? (
          <input
            required
            value={selection.model}
            placeholder="Exact Requesty model ID"
            onChange={(event) =>
              onChange({
                ...selection,
                model: event.target.value,
                reasoning: null,
              })
            }
          />
        ) : (
          <select
            disabled={!selection}
            required={Boolean(selection)}
            value={selection?.model ?? ''}
            onChange={(event) =>
              selection &&
              onChange({
                ...selection,
                model: event.target.value,
                reasoning: null,
              })
            }
          >
            <option value="">Choose a model</option>
            {provider?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
      </label>
      <label>
        Title reasoning
        <select
          disabled={!model?.reasoning.length}
          value={selection?.reasoning ?? ''}
          onChange={(event) =>
            selection &&
            onChange({ ...selection, reasoning: event.target.value || null })
          }
        >
          <option value="">Provider default</option>
          {model?.reasoning.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
