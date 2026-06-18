import tseslint from 'typescript-eslint';

export default tseslint.config({
  extends: [...tseslint.configs.recommended],
  files: ['src/**/*.ts'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-console': 'off',
  },
});
