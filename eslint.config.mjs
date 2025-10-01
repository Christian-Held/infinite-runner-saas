import tseslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier';

export default tseslint.config(
  {
    ignores: ['dist', 'build', 'node_modules']
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      prettier: prettierPlugin
    },
    rules: {
      'prettier/prettier': 'error'
    }
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      sourceType: 'module'
    }
  }
);
