import { describe, expect, it } from "vitest";
import { evaluatingModules } from "./vite-no-eval";

const chunk = (modules: Record<string, string>) => ({ type: "chunk", modules: Object.fromEntries(Object.entries(modules).map(([id, code]) => [id, { code }])) });

describe("evaluatingModules", () => {
  it("finds every form that evaluates text, by module, and nothing that only looks like it", () => {
    const found = evaluatingModules({
      "player.js": chunk({
        "/repo/packages/runtime/src/shim.ts": "const fn = new Function(\"extensions\", body); const g = Function(`a`, b);",
        "/repo/node_modules/@babylonjs/core/Misc/tools.pure.js": "try { Function(data).apply(null); } catch {}",
        "/repo/node_modules/some-lib/index.js": "window.eval(code); eval (text);",
        // Names that end in Function, methods named eval, and the constructor read but not called evaluate nothing.
        "/repo/node_modules/draco/wrapper.js": "this.asyncExecuteFunction(f); obj.eval(x); const isFn = value instanceof Function;",
      }),
      "style.css": { type: "asset" },
    });
    expect(Object.fromEntries(found)).toEqual({
      "packages/runtime/src/shim.ts": 2,
      "@babylonjs/core/Misc/tools.pure.js": 1,
      "some-lib/index.js": 2,
    });
  });
});
