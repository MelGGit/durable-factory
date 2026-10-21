import { runDiagnostic } from '../apps/server/src/diagnostics.js';
import { ApiError } from '../packages/shared/src/index.js';
try {
  await runDiagnostic(process.argv.slice(2));
} catch (error) {
  console.error(
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : 'Diagnostic failed. Check runtime storage permissions.',
  );
  process.exitCode = 1;
}
