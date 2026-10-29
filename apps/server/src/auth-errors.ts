import { CredentialStorageError } from './credentials.js';

export type AuthFailureCode =
  | 'storage_unavailable'
  | 'callback_unavailable'
  | 'authorization_failed'
  | 'network_failed'
  | 'provider_failed';
export class AuthFailure extends Error {
  constructor(
    public readonly category: AuthFailureCode,
    message: string,
  ) {
    super(message);
  }
}
/** Inspect known error patterns only; never retain raw errors, causes or token bodies. */
export function safeAuthFailure(error: unknown): AuthFailure {
  if (error instanceof AuthFailure) return error;
  if (error instanceof CredentialStorageError)
    return new AuthFailure('storage_unavailable', error.message);
  if (
    error instanceof Error &&
    (error.cause instanceof AuthFailure ||
      error.cause instanceof CredentialStorageError)
  )
    return safeAuthFailure(error.cause);
  const message = error instanceof Error ? error.message : '';
  if (/Port 1455 is in use|EADDRINUSE/.test(message))
    return new AuthFailure(
      'callback_unavailable',
      'The sign-in callback port is busy. Cancel other pending sign-ins and retry.',
    );
  if (
    /state mismatch|Missing authorization code|callback URL|invalid_grant|authorization failed|did not include|denied/i.test(
      message,
    )
  )
    return new AuthFailure(
      'authorization_failed',
      'Authorization was rejected or incomplete. Start a new sign-in and use its browser link.',
    );
  if (/fetch failed|ENOTFOUND|ECONN|timed? ?out|network/i.test(message))
    return new AuthFailure(
      'network_failed',
      'The provider could not be reached. Check your connection and retry.',
    );
  return new AuthFailure(
    'provider_failed',
    'The provider could not complete authentication. Check account access and start a new sign-in.',
  );
}

export function validateCallbackHost() {
  const host = process.env.PI_OAUTH_CALLBACK_HOST;
  if (host && !['127.0.0.1', '::1', 'localhost'].includes(host))
    throw new AuthFailure(
      'callback_unavailable',
      'OAuth callback listeners must use a loopback address. Remove PI_OAUTH_CALLBACK_HOST or set it to 127.0.0.1.',
    );
}
