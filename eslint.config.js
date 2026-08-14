// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // These live inside the repo but are not product code: teaching material,
  // planning artifacts, the writable copy a bench edits, and the probes.
  //
  // The probes are the odd ones out — they *are* tracked, because they are the
  // evidence behind the conclusions in docs/adr and CONTEXT.md and evidence that
  // only exists on one machine is not evidence. They still sit outside the
  // toolchain: none of this is in tsconfig's project, so the type-checked rules
  // cannot parse them and `bun run check` fails on files it was never meant to
  // judge. bench/fixture/ has a second reason — reformatting it invalidates
  // every baseline ever recorded (bench/README.md).
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "learn/**",
      ".scratch/**",
      "bench-work/**",
      "bench/**",
      "repro/**",
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
