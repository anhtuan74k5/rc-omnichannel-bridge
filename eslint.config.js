'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**', '.claude/**', 'logs/**', 'data/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['warn', 'always', { null: 'ignore' }],
      'no-var': 'warn',
      'prefer-const': 'warn',
      // Added in ESLint 9+ recommended; 3 existing hits, kept as warn until refactor settles.
      'no-useless-assignment': 'warn',
    },
  },
];
