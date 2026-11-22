import { describe, expect, it } from "vitest";
import { loadCompiledModule } from "./module-loader";

const entries = (...names: string[]) => names.map((name) => ({ name }));

describe("compiled module loading", () => {
  it("preserves authored strings, templates, regular expressions and comments containing export text", async () => {
    const source = [
      "// export function commentGhost() {}",
      "/* export async function blockGhost() {} */",
      "const template = `export function templateGhost",
      "export function lineGhost(ctx) {",
      "//# sourceURL=haptic:///authored-template.js",
      '${`export function nested ${"export function expressionGhost"}`}`;',
      "export function run() {",
      '  return ["export function stringGhost", "export async function asyncGhost", template, /export function regexGhost/.source];',
      "}",
    ].join("\n");
    const module = await loadCompiledModule({ source, entryPoints: entries("run") }, "literal-fixture");
    expect(Object.keys(module)).toEqual(["run"]);
    expect(module.run?.()).toEqual([
      "export function stringGhost", "export async function asyncGhost",
      "export function templateGhost\nexport function lineGhost(ctx) {\n//# sourceURL=haptic:///authored-template.js\nexport function nested export function expressionGhost",
      "export function regexGhost",
    ]);
  });

  it("exports exactly the listed entry points, synchronous and asynchronous, in list order", async () => {
    const source = [
      "var offset = 1;",
      "function helper(value) { return value + offset; }",
      "export async function $run(value) { return await Promise.resolve(helper(value)); }",
      "export function onTick(ctx) { return helper(ctx); }",
      "export function Jump_2(ctx) { return -ctx; }",
    ].join("\n");
    const module = await loadCompiledModule({ source, entryPoints: entries("onTick", "$run", "Jump_2") }, "several-fixture");
    expect(Object.keys(module)).toEqual(["onTick", "$run", "Jump_2"]);
    expect(module.onTick?.(2)).toBe(3);
    await expect((module.$run as (value: number) => Promise<number>)(7)).resolves.toBe(8);
    expect((module.Jump_2 as (value: number) => number)(4)).toBe(-4);
    expect("helper" in module).toBe(false);
  });

  it("loads a module without exports", async () => {
    const module = await loadCompiledModule({
      source: "//# sourceURL=haptic:///empty.js\nvar __unused = () => 1;\n",
      entryPoints: [],
    }, "empty-fixture");
    expect(module).toEqual({});
  });

  it("refuses an export list the source does not declare exactly once", async () => {
    await expect(loadCompiledModule({ source: "function run() {}", entryPoints: entries("run") }, "missing"))
      .rejects.toThrow("Script missing: export run must be declared once at the start of a line as an exported function (found 0).");
    const twice = ["const authored = `", "export function run() {}`;", "export function run() { return authored; }"].join("\n");
    await expect(loadCompiledModule({ source: twice, entryPoints: entries("run") }, "twice"))
      .rejects.toThrow("Script twice: export run must be declared once at the start of a line as an exported function (found 2).");
  });

  it("exports a function once when it serves several entry points", async () => {
    // Compiled entry points carry more than the loader reads (the event each one serves).
    const entryPoints = [{ name: "probe", event: "onTick" }, { name: "probe", event: "probe" }];
    const module = await loadCompiledModule({
      source: "export function probe(ctx) { return ctx + 1; }",
      entryPoints,
    }, "shared-fixture");
    expect(Object.keys(module)).toEqual(["probe"]);
    expect((module.probe as (value: number) => number)(1)).toBe(2);
  });

  it("preserves strict module function semantics", async () => {
    const module = await loadCompiledModule({
      source: [
        "export function run() { return this; }",
        "export function leak() { __slate_unbound_module_fixture = 1; }",
      ].join("\n"),
      entryPoints: entries("run", "leak"),
    }, "strict-fixture");
    const unbound = module.run!;
    expect(unbound()).toBeUndefined();
    expect(() => (module.leak as () => void)()).toThrow(ReferenceError);
    expect("__slate_unbound_module_fixture" in globalThis).toBe(false);
  });
});
