import { describe, expect, it } from "vitest";
import { loadCompiledModule } from "./module-loader";

describe("compiled module loading", () => {
  it("preserves authored strings, templates, regular expressions and comments containing export text", async () => {
    const source = [
      "// export function commentGhost() {}",
      "/* export async function blockGhost() {} */",
      "const template = `export function templateGhost",
      "//# sourceURL=babylonslate:///authored-template.js",
      '${`export function nested ${"export function expressionGhost"}`}`;',
      "export function run() {",
      '  return ["export function stringGhost", "export async function asyncGhost", template, /export function regexGhost/.source];',
      "}",
    ].join("\n");
    const module = await loadCompiledModule(source, "literal-fixture");
    expect(Object.keys(module)).toEqual(["run"]);
    expect(module.run?.()).toEqual([
      "export function stringGhost", "export async function asyncGhost",
      "export function templateGhost\n//# sourceURL=babylonslate:///authored-template.js\nexport function nested export function expressionGhost",
      "export function regexGhost",
    ]);
  });

  it("loads actual asynchronous exports with comments and valid identifier characters", async () => {
    const module = await loadCompiledModule(
      "export /* declaration comment */ async function $run(value) { return await Promise.resolve(value + 1); }",
      "async-fixture",
    );
    expect(Object.keys(module)).toEqual(["$run"]);
    await expect((module.$run as (value: number) => Promise<number>)(7)).resolves.toBe(8);
  });

  it("preserves strict module function semantics", async () => {
    const module = await loadCompiledModule([
      "export function run() { return this; }",
      "export function leak() { __slate_unbound_module_fixture = 1; }",
    ].join("\n"), "strict-fixture");
    const unbound = module.run!;
    expect(unbound()).toBeUndefined();
    expect(() => (module.leak as () => void)()).toThrow(ReferenceError);
    expect("__slate_unbound_module_fixture" in globalThis).toBe(false);
  });
});
