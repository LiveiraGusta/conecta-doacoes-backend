import tseslint from 'typescript-eslint';

const restrict = (files, patterns, message) => ({
  files,
  rules: {
    'no-restricted-imports': ['error', { patterns: patterns.map((group) => ({ group: [group], message })) }],
  },
});

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // ADR-11: cada camada só conhece a de baixo; só o repository conhece SQL.
  restrict(['src/**/*.routes.ts'], ['**/*.service', '**/*.repository', '**/core/db'], 'routes só importa controller, dto e core/auth.'),
  restrict(['src/**/*.controller.ts'], ['**/*.repository', '**/*.routes', '**/core/db', '**/core/storage'], 'controller só importa service e dto.'),
  restrict(['src/**/*.service.ts'], ['**/*.controller', '**/*.routes', 'fastify'], 'service não conhece HTTP.'),
  restrict(['src/**/*.repository.ts'], ['**/*.service', '**/*.controller', '**/*.routes', '**/core/errors/*'], 'repository só importa core/db e types.'),
  restrict(['src/**/*.dto.ts'], ['**/*.repository', '**/*.service', '**/core/db'], 'dto só importa zod e types.'),
);
