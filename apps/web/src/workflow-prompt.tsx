import React, { useState } from 'react';
import {
  ChatClient,
  type TranscriptEntry,
} from '../../../packages/shared/src/index.js';
import { ActivityDisclosure } from './activity-disclosure.js';
import { ArtifactText, useCachedState } from './tool-activity.js';

const client = new ChatClient();

/** The disclosure never substitutes its summary for the submitted payload. */
export function WorkflowPrompt({
  entry,
  conversationId,
  itemKey,
}: {
  entry: TranscriptEntry;
  conversationId: string;
  itemKey: string;
}) {
  const [open, setOpen] = useCachedState(
    JSON.stringify(['workflow-prompt', conversationId, entry.id]),
    !entry.presentation?.defaultCollapsed,
  );
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState('');
  const copy = async () => {
    setCopying(true);
    setError('');
    try {
      let text = entry.text;
      if (entry.textArtifact) {
        text = '';
        let offset = 0;
        for (;;) {
          const page = await client.artifact(
            conversationId,
            entry.textArtifact,
            offset,
          );
          text += page.text;
          if (page.nextOffset === undefined) break;
          offset = page.nextOffset;
        }
      }
      await navigator.clipboard.writeText(text);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not copy prompt.',
      );
    } finally {
      setCopying(false);
    }
  };
  return (
    <ActivityDisclosure
      className="message event-message workflow-prompt"
      data-conversation-item={itemKey}
      open={open}
      onOpenChange={setOpen}
    >
      <summary>
        <strong>Workflow</strong> ·{' '}
        {entry.presentation?.summary ?? 'Agent context supplied'}
      </summary>
      {open && (
        <div className="workflow-prompt-content">
          <button
            type="button"
            className="secondary"
            disabled={copying}
            onClick={() => void copy()}
          >
            {copying ? 'Copying…' : 'Copy full prompt'}
          </button>
          <pre>{entry.text}</pre>
          {entry.textArtifact && (
            <ArtifactText
              conversationId={conversationId}
              artifact={entry.textArtifact}
              label="prompt"
            />
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </ActivityDisclosure>
  );
}
