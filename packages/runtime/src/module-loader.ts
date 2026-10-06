import { parse } from "acorn";

/** Function constructor wrapper (two lines), then the strict directive. */
export const COMPILED_MODULE_LINE_OFFSET = 3;

export interface CompiledModuleExports {
  run?: (...args: unknown[]) => unknown;
  onTick?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

/**
 * Generated graphs export functions. The module shim keeps their functions
 * collectable when source ownership ends; dynamic-import module records remain
 * rooted in the browser realm even after their Blob URL is revoked.
 */
export async function loadCompiledModule(
  source: string,
  label: string,
): Promise<CompiledModuleExports> {
  return loadViaFunctionShim(source, label);
}

function loadViaFunctionShim(source: string, label: string): CompiledModuleExports {
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const names: string[] = [];
  const exportOffsets: number[] = [];
  for (const statement of program.body) {
    if (statement.type === "ExportNamedDeclaration" && statement.declaration?.type === "FunctionDeclaration") {
      names.push(statement.declaration.id.name);
      exportOffsets.push(statement.start);
    } else if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ||
      statement.type === "ExportAllDeclaration" || statement.type === "ImportDeclaration") {
      throw new Error(`Script ${label}: generated modules must export function declarations.`);
    }
  }
  // Blank just the parsed export tokens: strings, comments, templates, regexp
  // bodies, line numbers and all declaration columns remain untouched.
  let body = source;
  for (const start of exportOffsets.reverse()) body = `${body.slice(0, start)}      ${body.slice(start + 6)}`;
  const members = names.map((name) => `[${JSON.stringify(name)}]: ${name}`).join(",");
  // A final real directive supersedes previous source labels without rewriting
  // authored text that happens to contain a sourceURL-looking template line.
  const fn = new Function(`"use strict";\n${body}\nreturn {${members}};\n//# sourceURL=babylonslate:///${label}.js\n`);
  return fn() as CompiledModuleExports;
}
