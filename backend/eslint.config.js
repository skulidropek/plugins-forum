// @ts-check

import js from "@eslint/js";
import globals from "globals";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import tseslint from "typescript-eslint";
import suggestMembers from "@ton-ai-core/eslint-plugin-suggest-members";

// CHANGE: Добавили ESLint-конфигурацию, наследованную из фронтенда, адаптированную под Node-среду бэкенда.
// WHY: Требование подключить ESLint к проекту и использовать те же проверки, что и на фронте, для поддержания единого стиля.
// QUOTE(TЗ): "И добавь в проект eslint Перенеси eslint просто из frontend части"
// REF: REQ-REMOTE-CLEANUP-001
// SOURCE: internal-analysis

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "src/index.ts",
      "src/author-repository-finder.ts",
      "src/repository-crawler.ts"
    ]
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    files: ["src/repository-cleanup-service.ts", "src/__tests__/**/*.ts", "lint.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.node
      },
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: ["./tsconfig.eslint.json"]
      }
    },
    plugins: {
      "@eslint-community/eslint-comments": eslintComments,
      "@ton-ai-core/suggest-members": suggestMembers
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-expressions": "error",
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@eslint-community/eslint-comments/no-use": "error",
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      "@eslint-community/eslint-comments/disable-enable-pair": "error",
      "@eslint-community/eslint-comments/no-unused-disable": "error",
      "@ton-ai-core/suggest-members/suggest-members": "error",
      "@ton-ai-core/suggest-members/suggest-imports": "error",
      "@ton-ai-core/suggest-members/suggest-module-paths": "error"
    }
  }
);
