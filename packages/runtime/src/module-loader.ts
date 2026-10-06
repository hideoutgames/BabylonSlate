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
  const directive = `//# sourceURL=babylonslate:///${label}.js`;
  const withUrl = /^\s*\/\/# sourceURL=.*$/m.test(source)
    ? source.replace(/^[ \t]*\/\/# sourceURL=.*$/gm, directive)
    : `${source}\n${directive}\n`;

  return loadViaFunctionShim(withUrl);
}

function loadViaFunctionShim(source: string): CompiledModuleExports {
  const names = collectExportedFunctionNames(source);
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  const exports: CompiledModuleExports = {};
  const module = { exports };
  const assign = names
    .map((name) => `exports[${JSON.stringify(name)}] = ${name};`)
    .join("\n");
  const fn = new Function(
    "exports",
    "module",
    `${body}\n${assign}\nreturn module.exports;`,
  );
  return fn(exports, module) as CompiledModuleExports;
}

function collectExportedFunctionNames(source: string): string[] {
  const names: string[] = [];
  const re = /export\s+(?:async\s+)?function\s+(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    names.push(match[1]!);
  }
  return names;
}
