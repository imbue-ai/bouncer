import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,

  // Shared rule overrides
  {
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
    },
  },

  // Browser source code (JS)
  {
    files: [
      'src/**/*.js',
      'adapters/**/*.js',
      'background.js',
      'popup.js',
      'content.js',
      'adapters/twitter/fiber-extractor.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        chrome: 'readonly',
        FeedFilterAdapter: 'readonly',
        DOMPurify: 'readonly',
        process: 'readonly',
      },
    },
  },

  // Browser source code (TS) — type-checked rules
  {
    files: [
      'src/**/*.ts',
      'adapters/**/*.ts',
    ],
    extends: tseslint.configs.recommendedTypeChecked,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        chrome: 'readonly',
        FeedFilterAdapter: 'readonly',
        DOMPurify: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'off',
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
    },
  },

  // build.js and utility scripts (ESM, Node)
  {
    files: ['build.js', 'cut.js', 'update-webllm.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },

  // Test files — standard TS rules (not type-checked; tests use dynamic mocks)
  {
    files: ['tests/**/*.ts'],
    extends: tseslint.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        vi: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },

  // Vitest config
  {
    files: ['vitest.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },

  // Ignores
  {
    ignores: [
      'dist/',
      'node_modules/',
      'vendor/',
      'dompurify.js',
      'browser-polyfill.js',
    ],
  },
);
