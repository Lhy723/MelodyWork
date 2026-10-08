import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      "vendor/**",
      "plugins/**",
    ],
  },
  eslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [tseslint.configs.recommended],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "no-undef": "off",
      "no-useless-escape": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    rules: {
      "no-undef": "off",
      "no-useless-escape": "off",
      "no-unused-vars": "warn",
    },
  },
  {
    // The agent contract/worker packages are TypeScript-first: types come from
    // tsc, and the .mjs files are type-stripped tests with Node globals.
    files: ["packages/**/*.{ts,mjs}"],
    extends: [tseslint.configs.recommended],
    rules: {
      "no-undef": "off",
      "no-useless-escape": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
