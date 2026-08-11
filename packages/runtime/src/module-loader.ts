export interface CompiledModuleExports {
  run?: (...args: unknown[]) => unknown;
  onTick?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

/**
 * Load a compiled game script. Prefers blob-URL dynamic import; falls back to
 * `new Function` + module-shim when blob import fails (WKWebView spike path).
 */
export async function loadCompiledModule(
  source: string,
  label: string,
): Promise<CompiledModuleExports> {
  const withUrl = source.includes("sourceURL=")
    ? source
    : `${source}\n//# sourceURL=babylonslate:///${label}.js\n`;

  if (typeof URL !== "undefined" && typeof Blob !== "undefined") {
    try {
      const blob = new Blob([withUrl], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      try {
        const mod = (await import(
          /* @vite-ignore */ url
        )) as CompiledModuleExports;
        return mod;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      // fall through to Function shim
    }
  }

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
