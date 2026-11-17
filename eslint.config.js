import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/', 'migrations/', 'src/prisma/contract.d.ts', 'src/prisma/contract.json'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
