import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // Fastify plugins and BullMQ processors are async by contract even
      // when a given implementation has nothing to await yet.
      "@typescript-eslint/require-await": "off",
      "no-console": "error",
    },
  },
  {
    // Boot failure is reported before a logger exists.
    files: ["apps/*/src/server.ts", "apps/*/src/main.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.js"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
