/** Function constructor wrapper (two lines), then the strict directive. */
export const COMPILED_MODULE_LINE_OFFSET = 3;

export interface CompiledModuleExports {
  run?: (...args: unknown[]) => unknown;
  onTick?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

/**
 * What the loader reads from a compiled script. The entry point names are the
 * module's complete export list (one function may serve several entry points):
 * the compiler declares each export once, at the start of a line, as
 * `export function <name>(` or `export async function <name>(`, and exports
 * nothing else.
 */
export interface CompiledModuleSource {
  source: string;
  entryPoints: ReadonlyArray<{ name: string }>;
}

/** An exported function declaration starting a line (after any indentation); group 1 is its name. */
const EXPORT_DECLARATION = /(?<=^[ \t]*)export(?= (?:async )?function ([A-Za-z_$][\w$]*)\()/gm;

/**
 * Generated graphs export functions. The module shim keeps their functions
 * collectable when source ownership ends; dynamic-import module records remain
 * rooted in the browser realm even after their Blob URL is revoked.
 */
export async function loadCompiledModule(
  module: CompiledModuleSource,
  label: string,
): Promise<CompiledModuleExports> {
  return loadViaFunctionShim(module, label);
}

function loadViaFunctionShim({ source, entryPoints }: CompiledModuleSource, label: string): CompiledModuleExports {
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
  for (const start of exportOffsets.sort((a, b) => b - a)) body = `${body.slice(0, start)}      ${body.slice(start + 6)}`;
  const members = names.map((name) => `[${JSON.stringify(name)}]: ${name}`).join(",");
  // A final real directive supersedes previous source labels without rewriting
  // authored text that happens to contain a sourceURL-looking template line.
  const fn = new Function(`"use strict";\n${body}\nreturn {${members}};\n//# sourceURL=haptic:///${label}.js\n`);
  return fn() as CompiledModuleExports;
}
