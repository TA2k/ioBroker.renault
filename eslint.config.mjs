import config from '@iobroker/eslint-config';
import globals from 'globals';

export default [
  {
    ignores: ['.references/**', 'admin/i18n/**', 'lib/adapter-config.d.ts'],
  },
  ...config,
  {
    rules: {
      // JSDoc carries the types for `tsc --checkJs`, not documentation.
      'jsdoc/check-tag-names': 'off',
      'jsdoc/no-defaults': 'off',
      'jsdoc/reject-any-type': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/tag-lines': 'off',
      // The code base keeps its own .prettierrc.js style and is not formatted by the lint run.
      'prettier/prettier': 'off',
      'prefer-template': 'off',
    },
  },
  {
    files: ['**/*.test.js', 'test/**/*.js'],
    languageOptions: {
      globals: globals.mocha,
    },
  },
];
