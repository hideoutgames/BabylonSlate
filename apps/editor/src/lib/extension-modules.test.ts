import { describe, expect, it } from "vitest";
import { evaluateExtensionBundle, EXTENSION_HOST_MODULE, extensionHostModule, platformSymbols } from "@haptic/core";
import { linkExtensionModules } from "./extension-modules";

const WEB = platformSymbols("web", { editor: true });

function link(files: Record<string, string>, entry = "index.ts") {
  return linkExtensionModules(Object.entries(files).map(([path, source]) => ({ path, source })), entry, WEB);
}

describe("linkExtensionModules", () => {
  it("turns representative TypeScript into working CommonJS that resolves its package imports", async () => {
    const bundle = await link({
      "index.ts": [
        `import type { EditorApi } from "./code/types";`,
        `import { Shape, area, type Box } from "./code/shapes";`,
        `import * as names from "./code/names.js";`,
        `import scale from "./code/scale";`,
        `export * from "./code/shapes";`,
        `enum Mode { Draft, Final = 4 }`,
        `const enum Flag { On = 1 }`,
        `abstract class Base<T> { constructor(protected readonly value: T) {} abstract twice(): T; }`,
        `class Doubler extends Base<number> { twice(): number { return this.value * 2; } }`,
        `export function activate(api: EditorApi): () => void {`,
        `  const box = { width: 2, height: 3 } satisfies Box;`,
        `  const label = (api as { label?: string }).label ?? names.fallback;`,
        `  api.log(\`\${label}:\${area(box)}:\${new Doubler(scale(Mode.Final)).twice()}:\${Flag.On}:\${Shape.Square}\`);`,
        `  return () => api.log("stopped");`,
        `}`,
      ].join("\n"),
      "code/types.ts": "export interface EditorApi { log(message: string): void }",
      "code/shapes.ts": "export enum Shape { Square = 'square' }\nexport interface Box { width: number; height: number }\nexport const area = (box: Box): number => box.width * box.height;",
      "code/names.ts": "export const fallback: string = 'tools';",
      "code/scale.ts": "export default function scale(value: number): number { return value * 10; }",
    });

    expect(bundle.modules.map((module) => module.path)).toEqual(["index.ts", "code/shapes.ts", "code/names.ts", "code/scale.ts"]);
    // The type-only module is never linked: its import is erased.
    expect(bundle.modules[0]!.imports).toEqual({ "./code/shapes": "code/shapes.ts", "./code/names.js": "code/names.ts", "./code/scale": "code/scale.ts" });
    const logs: string[] = [];
    const exports = evaluateExtensionBundle(bundle, "Tools");
    const stop = (exports.activate as (api: { log(message: string): void }) => () => void)({ log: (message) => logs.push(message) });
    stop();
    expect(logs).toEqual(["tools:6:80:1:square", "stopped"]);
    expect(exports.area).toBeTypeOf("function");
  });

  it("keeps each line where the source had it", async () => {
    const source = "import type { A } from './a';\ninterface B { b: number }\n\nexport const marker: string = 'here';\n";
    const [module] = (await link({ "index.ts": source })).modules;
    expect(module!.code.split("\n").findIndex((line) => line.includes("'here'"))).toBe(3);
  });

  it("gives game code its own extension data through haptic:extension and plain JavaScript files", async () => {
    const bundle = await link({
      "game.ts": "import { settings } from 'haptic:extension';\nconst helper = require('./code/helper.js');\nexport const describe = (): string => `${settings.region}:${helper.twice(2)}`;",
      "code/helper.js": "exports.twice = (value) => value * 2;",
    }, "game.ts");
    expect(bundle.modules[0]!.imports).toEqual({ [EXTENSION_HOST_MODULE]: EXTENSION_HOST_MODULE, "./code/helper.js": "code/helper.js" });
    const exports = evaluateExtensionBundle(bundle, "Weather", {}, { [EXTENSION_HOST_MODULE]: extensionHostModule({ settings: { region: "north" }, assets: [] }) });
    expect((exports.describe as () => string)()).toBe("north:4");
  });

  it.each([
    [{ "index.ts": "export const load = () => import('./code/late');", "code/late.ts": "" }, "index.ts: Dynamic import() is not supported. Use a static import."],
    [{ "index.ts": "const name = './x';\nexport const x = require(name);" }, "index.ts: Import paths must be string literals."],
    [{ "index.ts": "export const x = require('./a', 1);" }, "index.ts: require() takes one path."],
    [{ "index.ts": "import fs from 'node:fs';\nexport const read = fs.readFileSync;" }, `index.ts: Extension code can import only files in its own extension, not "node:fs".`],
    [{ "index.ts": "import { x } from '../outside';\nexport const y = x;" }, `index.ts: "../outside" is outside the extension.`],
    [{ "index.ts": "\nexport const x: = 1;" }, /^index\.ts:2:\d+: Unexpected token$/],
  ])("refuses %j", async (files, message) => {
    await expect(link(files)).rejects.toThrow(message);
  });

  it("ignores require text inside strings, comments and regular expressions", async () => {
    const bundle = await link({ "index.ts": "// require('./comment')\nexport const text = \"require('./string')\";\nexport const pattern = /require\\('x'\\)/;" });
    expect(bundle.modules[0]!.imports).toEqual({});
  });
});
