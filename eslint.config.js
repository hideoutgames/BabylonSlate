import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const noReactInPure = {
  files: ["packages/core/**/*.ts", "packages/vfs/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          { name: "react", message: "Pure packages must not import React." },
          {
            name: "@babylonjs/core",
            message: "Pure packages must not import Babylon.",
          },
        ],
      },
    ],
  },
};

const noReactInRender = {
  files: ["packages/render/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          { name: "react", message: "render must not import React." },
        ],
      },
    ],
  },
};

export default tseslint.config(
  { ignores: ["dist", "ios", "android", "node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  noReactInPure,
  noReactInRender,
);
