/**
 * A compiled Logic Graph module: its JavaScript source, whose exports are exactly its entry points. The compiler
 * declares each export once, at the start of a line, as `export function <name>(` or `export async function <name>(`,
 * and exports nothing else.
 */
export interface CompiledModuleSource {
  source: string;
  entryPoints: ReadonlyArray<{ name: string }>;
}

/** A compiled script's source label: its `haptic:///<label>.js` URL in Editor Play, its key in a game's scripts module. */
export function compiledScriptSourceLabel(script: { assetGuid: string; classId: string }): string {
  return `${script.assetGuid}~${encodeURIComponent(script.classId)}`;
}

/** An exported function declaration starting a line (after any indentation); group 1 is its name. */
const EXPORT_DECLARATION = /(?<=^[ \t]*)export(?= (?:async )?function ([A-Za-z_$][\w$]*)\()/gm;

/**
 * The module as the body of a function of `extensions` that returns its exports: Editor Play wraps it in `new Function`,
 * an exported game's static scripts module in a function literal. Only the `export` keywords change (blanked in place),
 * so every source line and column stays where the compiler put it (anchors map stack frames by them), and one line
 * after the source returns the exports.
 */
export function compiledModuleBody({ source, entryPoints }: CompiledModuleSource, label: string): string {
  const declarations = new Map<string, number[]>(entryPoints.map((point) => [point.name, []]));
  const names = [...declarations.keys()];
  // Only listed names are exports: a line-start lookalike with another name
  // sits in authored text (a template or comment line) and stays as written.
  for (const match of source.matchAll(EXPORT_DECLARATION)) {
    declarations.get(match[1]!)?.push(match.index);
  }
  const exportOffsets: number[] = [];
  for (const [name, offsets] of declarations) {
    if (offsets.length !== 1) {
      throw new Error(`Script ${label}: export ${name} must be declared once at the start of a line as an exported function (found ${offsets.length}).`);
    }
    exportOffsets.push(offsets[0]!);
  }
  // Blank just the export keywords: strings, comments, templates, regexp
  // bodies, line numbers and all declaration columns remain untouched.
  let body = source;
  // The compiler's own first-line `//# sourceURL=` comment would rename the whole file a game's scripts module holds
  // it in (engines take the last such comment), so it becomes an empty comment; Editor Play appends its own directive.
  const header = /^\/\/# sourceURL=haptic:\/\/\/[^\n]*/.exec(body);
  if (header) body = `//${" ".repeat(header[0].length - 2)}${body.slice(header[0].length)}`;
  for (const start of exportOffsets.sort((a, b) => b - a)) body = `${body.slice(0, start)}      ${body.slice(start + 6)}`;
  const members = names.map((name) => `[${JSON.stringify(name)}]: ${name}`).join(",");
  return `${body}\nreturn {${members}};`;
}

/** An exported game's static scripts module (`writeGameScriptsModule`), beside `game.json`. */
export const GAME_SCRIPTS_MODULE_FILE = "scripts/game-scripts.js";

/** A compiled module's function: given the game's Extension libraries, its exports. */
export type CompiledModuleFunction = (extensions: unknown) => Record<string, unknown>;

/** What an exported game's scripts module exports. */
export interface GameScriptsModule {
  /** The module's own URL (`import.meta.url`), as stack frames name it. */
  url: string;
  /** Each compiled script by `compiledScriptSourceLabel`: the file line holding its source's first line, and its function. */
  scripts: Readonly<Record<string, readonly [firstLine: number, module: CompiledModuleFunction]>>;
  /** Each Extension library's modules, by library name then module path: `(exports, module, require, extensions)`. */
  extensions: Readonly<Record<string, Readonly<Record<string, (...args: unknown[]) => void>>>>;
}

/**
 * The text of an exported game's scripts module: every compiled Logic Graph (`compiledModuleBody`) and every Extension
 * library module (its CommonJS code) as a function literal, so a game loads its code with one standard module import
 * and never evaluates text. It is a leaf module (no imports), loaded by URL. Its own bindings are `$$haptic`-prefixed so
 * a script's free names still reach the global scope, as they do in Editor Play's `new Function` modules.
 */
export function writeGameScriptsModule(
  scripts: readonly (CompiledModuleSource & { assetGuid: string; classId: string })[],
  libraries: readonly { libraryName: string; bundle: { modules: readonly { path: string; code: string }[] } }[],
): string {
  const parts: string[] = [];
  let line = 1;
  const emit = (text: string) => {
    parts.push(text);
    for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) line += 1;
    line += 1;
  };
  emit("// Compiled Logic Graphs and Extension libraries of this game, generated at export. A leaf module: no imports.");
  emit("const $$hapticUrl = import.meta.url;");
  emit("const $$hapticScripts = {");
  for (const script of scripts) {
    const label = compiledScriptSourceLabel(script);
    // The source's first line is the line after the function's opening line.
    emit(`${JSON.stringify(label)}: [${line + 1}, function (extensions) {`);
    emit(compiledModuleBody(script, label));
    emit("}],");
  }
  emit("};");
  emit("const $$hapticExtensions = {");
  for (const library of libraries) {
    emit(`${JSON.stringify(library.libraryName)}: {`);
    for (const module of library.bundle.modules) {
      emit(`${JSON.stringify(module.path)}: function (exports, module, require, extensions) {`);
      emit(module.code);
      emit("},");
    }
    emit("},");
  }
  emit("};");
  emit("export { $$hapticUrl as url, $$hapticScripts as scripts, $$hapticExtensions as extensions };");
  return `${parts.join("\n")}\n`;
}
