import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NativeCredentialVault } from '../apps/server/src/credential-vault.js';

test(
  'native vault smoke test touches only one unique fake entry',
  { skip: process.env.DURABLE_FACTORY_TEST_NATIVE_VAULT !== '1' },
  async () => {
    const vault = new NativeCredentialVault();
    const account = `test-only-${randomUUID()}`;
    try {
      assert.equal(await vault.get(account), undefined);
      await vault.set(account, 'fake-native-vault-smoke');
      assert.equal(await vault.get(account), 'fake-native-vault-smoke');
    } finally {
      await vault.delete(account);
    }
    assert.equal(await vault.get(account), undefined);
  },
);
