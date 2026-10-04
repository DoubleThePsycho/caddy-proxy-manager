import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import tseslint from 'typescript-eslint';

// Guard rails for the async, dialect-neutral database layer (SQLite and
// PostgreSQL; src/lib/db/README.md). Errors: production code is converted.
const PRODUCTION_FILES = ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}', 'ee/**/*.{ts,tsx}', 'proxy.ts'];
// Code that stays on synchronous bun:sqlite: the database layer itself and
// the high-availability cluster supervisor's local database.
const SQLITE_ONLY_FILES = ['src/lib/db/**', 'ee/high-availability/cluster/**'];
const SQLITE_DRIVER_MESSAGE =
  'Use the database facade (@/src/lib/db); only src/lib/db/** may use the SQLite driver directly.';
// SQLite-only SQL inside sql`` templates. LIKE is case-insensitive on SQLite
// and case-sensitive on PostgreSQL. src/lib/db/ops.ts has helpers for both.
const SQLITE_ONLY_SQL =
  /\b(ifnull|json_each|json_valid|json_extract|json_group_array|json_group_object|json_set|json_insert|json_remove|strftime|julianday|unixepoch|datetime|glob|last_insert_rowid|rowid|changes|group_concat|iif|printf|instr|nocase|pragma|sqlite_\w+|insert\s+or|replace\s+into|like)\b/i;

export default [
  {
    // public/maplibre holds maplibre-gl's minified worker bundle, staged from
    // node_modules at build time by scripts/copy-maplibre-worker.mjs.
    ignores: [
      '.next/**', 'out/**', 'build/**', 'next-env.d.ts', '.claude/**', 'public/maplibre/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
    plugins: {
      '@next/next': nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      '@next/next/no-img-element': 'off',
    },
  },
  {
    // Node config/build scripts (.mjs/.cjs) run outside Next's TS pipeline,
    // so declare the Node globals ESLint's no-undef cannot infer.
    files: ['**/*.{mjs,cjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: PRODUCTION_FILES,
    ignores: SQLITE_ONLY_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[arguments.length=0][callee.type="MemberExpression"][callee.property.name=/^(all|get|run)$/]',
          message:
            'Synchronous database call: await the query builder instead (first(q) for one row; see src/lib/db/README.md).',
        },
        {
          selector: `TaggedTemplateExpression[tag.name="sql"] > TemplateLiteral > TemplateElement[value.raw=${SQLITE_ONLY_SQL}]`,
          message: 'SQLite-only SQL in a sql`` template: use a dialect-neutral helper from src/lib/db/ops.ts.',
        },
        {
          selector:
            'TaggedTemplateExpression[tag.name="sql"] > TemplateLiteral[expressions.length=0] > TemplateElement[value.raw=/^\\s*[01]\\s*$/]',
          message: 'sql`0` and sql`1` are not booleans on PostgreSQL: use sqlFalse/sqlTrue from src/lib/db/ops.ts.',
        },
      ],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'bun:sqlite', message: SQLITE_DRIVER_MESSAGE },
            { name: 'drizzle-orm/bun-sqlite', message: SQLITE_DRIVER_MESSAGE },
            { name: 'drizzle-orm/bun-sqlite/migrator', message: SQLITE_DRIVER_MESSAGE },
            {
              name: 'drizzle-orm/sqlite-core',
              allowTypeImports: true,
              message: 'Only types may come from drizzle-orm/sqlite-core outside src/lib/db/**.',
            },
          ],
        },
      ],
    },
  },
  {
    // Type-aware: an async function called without await (a floating promise)
    // or used where a value is expected (if (isAllowed()) on a promise) is the
    // way a database call that turned async goes wrong silently.
    files: PRODUCTION_FILES,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksConditionals: true, checksSpreads: true, checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/await-thenable': 'error',
    },
  },
];
