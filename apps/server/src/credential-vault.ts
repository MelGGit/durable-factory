import type { CredentialVault } from './credentials.js';

/** No shell helpers: secrets never travel in argv, environment variables or files. */
export class NativeCredentialVault implements CredentialVault {
  readonly name =
    process.platform === 'darwin' ? 'macOS Keychain' : 'Linux Secret Service';
  private async entry(account: string) {
    if (!['darwin', 'linux'].includes(process.platform))
      throw new Error('Unsupported secure credential store');
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry('durable-factory', account, {
      linux: { store: 'secret-service' },
    });
  }
  async get(account: string) {
    return (await (await this.entry(account)).getPassword()) ?? undefined;
  }
  async set(account: string, value: string) {
    await (await this.entry(account)).setPassword(value);
  }
  async delete(account: string) {
    await (await this.entry(account)).deleteCredential();
  }
}
