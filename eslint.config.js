// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // learn/, .scratch/ and bench-work/ live inside the repo but are not product
  // code — teaching material, planning artifacts, and the writable copy a bench
  // edits. None is in tsconfig's project, so the type-checked rules cannot parse
  // them and `bun run check` fails on files it was never meant to judge.
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "learn/**",
      ".scratch/**",
      "bench-work/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Entry points are async by contract even before they await anything.
    files: ["src/main.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
