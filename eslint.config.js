// Biome handles formatting + the bulk of linting. ESLint exists ONLY for the
// type-aware async-safety rules Biome lacks (no-floating-promises /
// no-misused-promises) — critical for SSE/daemon-lifecycle cleanup (plan D1/D18).
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/.turbo/**'],
  },
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
)
