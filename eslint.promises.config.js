// Type-aware promise rules for the game runtime, storage and editor services: a promise there is awaited, handled, or
// marked `void` where fire-and-forget is intended and its failure is handled elsewhere.
//
// Separate from eslint.config.js because ESLint's cache keys a result on the file's own content, while these rules also
// read other files' types (a callee that becomes async changes its callers' results), so `pnpm lint`, which is cached,
// must not run them. `pnpm lint:promises` runs this config without a cache. Tests are left out: they have their own
// unawaited-setup patterns.
import base from "./eslint.config.js";

export default [
  ...base,
  { ignores: ["**/*.test.ts", "**/*.test.tsx"] },
  {
    // The folders `pnpm lint:promises` lints.
    files: ["packages/runtime/src/**/*.ts", "packages/vfs/src/**/*.ts", "apps/editor/src/services/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
];
