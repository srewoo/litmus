import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // The unit-testable layers. DOM glue (ui/sidepanel.ts), the browser-only
      // IndexedDB store, and type-only files are verified manually / by typecheck.
      include: [
        'src/core/**',
        'src/services/**',
        'src/shared/schema.ts',
        'src/shared/num.ts',
        'src/providers/**',
        'src/platform/storage.ts',
        'src/platform/store.ts',
        'src/ui/views.ts',
        'src/ui/target.ts',
        'src/ui/settingsForm.ts',
        'src/ui/providerDeps.ts',
        'src/ui/errors.ts',
      ],
      exclude: ['**/*.test.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 90,
      },
    },
  },
});
