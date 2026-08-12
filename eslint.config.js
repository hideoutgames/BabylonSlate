import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const REACT_PATTERNS = ["react", "react/*", "react-dom", "react-dom/*"];
const BABYLON_PATTERNS = ["@babylonjs/*", "@babylonjs/**"];
const CAPACITOR_PATTERNS = ["@capacitor/*", "@capacitor/**", "@daniele-rolli/*"];

/**
 * Import-boundary rules from engineplan section 2.2. Patterns are used rather
 * than exact paths because Babylon and Capacitor are normally imported by
 * subpath, which an exact-name rule would not catch.
 */
function boundary(name, files, groups) {
  return {
    name,
    files,
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: groups },
      ],
    },
  };
}

const pureNoReactNoBabylon = boundary(
  "boundary/pure-packages",
  [
    "packages/core/**/*.{ts,tsx}",
    "packages/assets/**/*.{ts,tsx}",
    "packages/edit/**/*.{ts,tsx}",
    "packages/object-model/**/*.{ts,tsx}",
    "packages/bridge/**/*.{ts,tsx}",
    "packages/runtime/**/*.{ts,tsx}",
    "packages/debugger/**/*.{ts,tsx}",
    "packages/input/**/*.{ts,tsx}",
    "packages/scripting/**/*.{ts,tsx}",
    "packages/scripting-nodes/**/*.{ts,tsx}",
    "packages/test-kit/**/*.{ts,tsx}",
  ],
  [
    {
      group: REACT_PATTERNS,
      message:
        "core, assets, edit, object-model, bridge, runtime, debugger, input, scripting, scripting-nodes, and test-kit must not import React (engineplan section 2.2).",
    },
    {
      group: BABYLON_PATTERNS,
      message:
        "core, assets, edit, object-model, bridge, runtime, debugger, input, scripting, scripting-nodes, and test-kit must not import Babylon (engineplan section 2.2).",
    },
    {
      group: CAPACITOR_PATTERNS,
      message: "Only vfs adapters may import Capacitor (engineplan section 2.2).",
    },
  ],
);

/**
 * Physics hosts Babylon Physics V2 on a worker-local NullEngine Scene.
 * It may import `@babylonjs/core` and `@babylonjs/havok`, but not React,
 * Capacitor, or editor-only Babylon packages (gui/loaders/inspector).
 */
const physicsNoReactNoCapacitor = boundary(
  "boundary/physics",
  ["packages/physics/**/*.{ts,tsx}"],
  [
    {
      group: REACT_PATTERNS,
      message: "physics must not import React (engineplan section 2.2).",
    },
    {
      group: [
        "@babylonjs/gui",
        "@babylonjs/gui/*",
        "@babylonjs/loaders",
        "@babylonjs/loaders/*",
        "@babylonjs/materials",
        "@babylonjs/materials/*",
        "@babylonjs/serializers",
        "@babylonjs/serializers/*",
        "@babylonjs/inspector",
        "@babylonjs/inspector/*",
      ],
      message:
        "physics may import @babylonjs/core Physics V2 and @babylonjs/havok only — not gui/loaders/inspector.",
    },
    {
      group: CAPACITOR_PATTERNS,
      message: "Only vfs adapters may import Capacitor (engineplan section 2.2).",
    },
  ],
);

const vfsNoReactNoBabylon = boundary(
  "boundary/vfs",
  ["packages/vfs/**/*.{ts,tsx}"],
  [
    {
      group: REACT_PATTERNS,
      message: "vfs must not import React (engineplan section 2.2).",
    },
    {
      group: BABYLON_PATTERNS,
      message: "vfs must not import Babylon (engineplan section 2.2).",
    },
  ],
);

const renderNoReact = boundary(
  "boundary/render",
  ["packages/render/**/*.{ts,tsx}"],
  [
    {
      group: REACT_PATTERNS,
      message: "render must not import React (engineplan section 2.2).",
    },
    {
      group: CAPACITOR_PATTERNS,
      message: "Only vfs adapters may import Capacitor (engineplan section 2.2).",
    },
  ],
);

/** Ban constructing Babylon Texture outside resource-cache.ts (engineplan §2.4). */
const renderTextureCacheOnly = {
  name: "boundary/render-texture-cache",
  files: ["packages/render/src/**/*.{ts,tsx}"],
  ignores: [
    "packages/render/src/resource-cache.ts",
    "packages/render/src/**/*.test.ts",
  ],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector:
          "NewExpression[callee.name='Texture'], NewExpression[callee.property.name='Texture']",
        message:
          "Construct textures only via ResourceCache (engineplan section 2.4).",
      },
    ],
  },
};

const uiNoBabylonNoCapacitor = boundary(
  "boundary/ui-packages",
  [
    "packages/ui/**/*.{ts,tsx}",
    "packages/editor-kit/**/*.{ts,tsx}",
    "packages/graph-ui/**/*.{ts,tsx}",
  ],
  [
    {
      group: BABYLON_PATTERNS,
      message:
        "UI packages talk to Babylon through the command bus, not directly.",
    },
    {
      group: CAPACITOR_PATTERNS,
      message: "Only vfs adapters may import Capacitor (engineplan section 2.2).",
    },
  ],
);

const appNoCapacitor = boundary(
  "boundary/app",
  ["apps/editor/src/**/*.{ts,tsx}"],
  [
    {
      group: CAPACITOR_PATTERNS,
      message:
        "UI must not call Capacitor directly; go through @babylonslate/vfs.",
    },
  ],
);

export default tseslint.config(
  {
    ignores: [
      "dist",
      "ios",
      "android",
      "node_modules",
      "coverage",
      "playwright-report",
      "test-results",
      "apps/docs/.vitepress/cache",
      "apps/docs/.vitepress/dist",
    ],
  },
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
  pureNoReactNoBabylon,
  physicsNoReactNoCapacitor,
  vfsNoReactNoBabylon,
  renderNoReact,
  renderTextureCacheOnly,
  uiNoBabylonNoCapacitor,
  appNoCapacitor,
);
