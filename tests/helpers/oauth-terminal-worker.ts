import assert from 'node:assert/strict';
import { runDiagnostic } from '../../apps/server/src/diagnostics.js';
import { FileVault } from './credentials.js';

const directory = process.argv[2];
process.env.DURABLE_FACTORY_DATA_DIR = directory;
try {
  await runDiagnostic(['login', 'anthropic'], {
    credentialVault: new FileVault(directory),
    oauthLogin: async (provider, store, interaction) => {
      const method = await interaction.prompt({
        type: 'select',
        message: 'Method',
        options: [
          { id: 'browser', label: 'Browser login' },
          { id: 'copy_code', label: 'Copy code login' },
        ],
      });
      assert.equal(method, 'browser');
      interaction.notify({
        type: 'auth_url',
        url: 'https://claude.ai/oauth/authorize?state=fake-terminal',
      });
      const code = await interaction.prompt({
        type: 'manual_code',
        message: 'Code',
      });
      assert.equal(code, 'sentinel-manual-code');
      await store.modify(provider, async () => ({
        type: 'oauth',
        access: 'sentinel-terminal-access',
        refresh: 'sentinel-terminal-refresh',
        expires: Date.now() + 3600000,
      }));
    },
  });
} catch {
  console.error('Terminal sign-in cancelled.');
  process.exitCode = 1;
}
