import React, { useEffect, useRef, useState } from 'react';
import {
  FactoryClient,
  ApiError,
  type OAuthProvider,
  type OAuthSession,
  type OAuthPrompt,
} from '../../../packages/shared/src/index.js';
import { Overlay } from './panels.js';

function LoginAnswer({
  prompt,
  submit,
  busy,
}: {
  prompt: OAuthPrompt;
  submit: (answer: string) => void;
  busy: boolean;
}) {
  const [answer, setAnswer] = useState(prompt.options?.[0]?.id ?? '');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const value = answer;
        if (!prompt.options) setAnswer('');
        submit(value);
      }}
    >
      <label htmlFor={`oauth-${prompt.id}`}>{prompt.message}</label>
      {prompt.options ? (
        <select
          id={`oauth-${prompt.id}`}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          disabled={busy}
        >
          {prompt.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={`oauth-${prompt.id}`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          disabled={busy}
        />
      )}
      <button
        type="submit"
        className="secondary"
        disabled={busy || !answer.trim()}
      >
        Continue
      </button>
    </form>
  );
}

export function OAuthConnection({
  client,
  provider,
  configured,
  changed,
}: {
  client: FactoryClient;
  provider: OAuthProvider;
  configured: boolean;
  changed: () => Promise<void>;
}) {
  const [session, setSession] = useState<OAuthSession | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const seen = useRef('');
  const dismissed = useRef('');
  const revision = useRef(0);
  const changedRef = useRef(changed);
  changedRef.current = changed;
  const name = provider === 'openai' ? 'ChatGPT' : 'Claude';
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const version = revision.current;
        const result = await client.loginStatus(provider);
        if (stopped) return;
        if (version !== revision.current) {
          timer = setTimeout(() => void poll(), 1000);
          return;
        }
        setSession(
          (previous) =>
            result.session ??
            (previous?.state === 'completed' ? previous : null),
        );
        if (
          result.session?.state === 'pending' &&
          result.session.id !== dismissed.current
        )
          setOpen(true);
        if (
          result.session?.state === 'completed' &&
          seen.current !== result.session.id
        ) {
          await changedRef.current();
          seen.current = result.session.id;
        }
      } catch {
        /* Remote clients cannot inspect local login sessions. Connect reports the error. */
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, provider]);
  async function act(work: () => Promise<void>) {
    revision.current++;
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      await work();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Sign-in could not complete. Retry.',
      );
    } finally {
      revision.current++;
      setBusy(false);
    }
  }
  function dismiss() {
    const closing = session;
    if (closing) dismissed.current = closing.id;
    // Release the modal immediately, even if cancellation fails or never settles.
    setOpen(false);
    void act(async () => {
      if (closing?.state !== 'pending') return;
      try {
        await client.cancelLogin(provider, closing.id);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'NOT_FOUND') return;
        throw new Error(
          'Sign-in cancellation could not be confirmed. It may still be active on the server. Reconnect to the service to check its status.',
        );
      }
    });
  }
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() =>
          void act(async () => {
            const result = await client.startLogin(provider);
            setSession(result.session);
            dismissed.current = '';
            setOpen(true);
          })
        }
      >
        {configured ? `Reconnect ${name}` : `Connect ${name}`}
      </button>
      {error && !open && (
        <p role="alert" className="connection-error">
          {error}
        </p>
      )}
      <Overlay
        open={open}
        label={`Connect ${name}`}
        closeDisabled={busy}
        onClose={dismiss}
      >
        {open && (
          <div className="oauth-dialog">
            {error && <p role="alert">{error}</p>}
            {session?.state === 'pending' && (
              <>
                <p>
                  Finish signing in on {name}’s website. You never need to paste
                  an access or refresh token here.
                </p>
                {session.authUrl && (
                  <div className="oauth-link-actions">
                    <a
                      className="button secondary"
                      href={session.authUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      referrerPolicy="no-referrer"
                    >
                      Open sign-in page
                    </a>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void navigator.clipboard
                          ?.writeText(session.authUrl!)
                          .then(
                            () => setCopied(true),
                            () =>
                              setError('Use Open sign-in page to continue.'),
                          )
                      }
                    >
                      Copy sign-in link
                    </button>
                    {copied && <span role="status">Link copied.</span>}
                  </div>
                )}
                {session.deviceCode && (
                  <p>
                    Open{' '}
                    <a
                      href={session.deviceCode.verificationUri}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      the verification page
                    </a>{' '}
                    and enter {session.deviceCode.userCode}.
                  </p>
                )}
                {session.prompt && (
                  <LoginAnswer
                    key={session.prompt.id}
                    prompt={session.prompt}
                    busy={busy}
                    submit={(answer) =>
                      void act(async () => {
                        setSession(
                          (
                            await client.answerLogin(
                              provider,
                              session.id,
                              session.prompt!.id,
                              answer,
                            )
                          ).session,
                        );
                      })
                    }
                  />
                )}
                {!session.prompt && <p role="status">Waiting for sign-in…</p>}
                <p className="muted">
                  Closing this dialog cancels sign-in. It expires after ten
                  minutes.
                </p>
              </>
            )}
            {session?.state === 'completed' && (
              <p role="status">
                Credentials stored securely. Model access is checked when you
                use the connection.
              </p>
            )}
            {session?.state === 'failed' && (
              <p role="alert">
                {session.error?.message ??
                  'Sign-in failed. Start a new sign-in.'}
              </p>
            )}
            {session?.state === 'cancelled' && (
              <p role="status">Sign-in cancelled.</p>
            )}
            {(session?.state === 'expired' || !session) && (
              <p role="status">
                Sign-in expired. Close this dialog and connect again.
              </p>
            )}
          </div>
        )}
      </Overlay>
    </>
  );
}
