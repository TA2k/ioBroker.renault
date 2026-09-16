import prettierConfig from '@iobroker/eslint-config/prettier.config.mjs';

// Keep the existing code style instead of reformatting the whole code base.
export default {
  ...prettierConfig,
  printWidth: 140,
  tabWidth: 2,
  arrowParens: 'always',
};
