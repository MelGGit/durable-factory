import React, { useState } from 'react';

export function CopyCommand({
  provider,
}: {
  provider: 'openai' | 'anthropic';
}) {
  const [notice, setNotice] = useState('');
  const command = `bun run diagnose login ${provider}`;
  return (
    <span className="command-copy">
      <code className="login-command">{command}</code>
      <button
        type="button"
        className="secondary"
        aria-label={`Copy ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} sign-in command`}
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(
            () => setNotice('Copied.'),
            () => setNotice('Select and copy the command above.'),
          );
          if (!navigator.clipboard)
            setNotice('Select and copy the command above.');
        }}
      >
        Copy
      </button>
      <span role="status" className={notice ? 'copy-notice' : 'sr-only'}>
        {notice}
      </span>
    </span>
  );
}
