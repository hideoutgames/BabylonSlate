import type { ExtensionCodeFile } from "@haptic/assets";
import { applyPlatformDirectives, EXTENSION_HOST_MODULE, type ExtensionModule, type ExtensionModuleBundle, type PlatformSymbol } from "@haptic/core";

type Sucrase = typeof import("sucrase");
type Acorn = typeof import("acorn");
type AcornNode = import("acorn").Node & Record<string, unknown>;

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Joins a relative specifier onto a package directory; null when it leaves the package. */
function joinPackagePath(directory: string, specifier: string): string | null {
  const parts = directory ? directory.split("/") : [];
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function resolveImport(from: string, specifier: string, sources: ReadonlyMap<string, string>): string {
  if (specifier === EXTENSION_HOST_MODULE) return specifier;
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new Error(`${from}: Extension code can import only files in its own extension, not "${specifier}".`);
  }
  const base = joinPackagePath(directoryOf(from), specifier);
  if (base === null) throw new Error(`${from}: "${specifier}" is outside the extension.`);
  const candidates = [base, `${base}.ts`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`];
  // TypeScript projects often write the emitted ".js" name for a ".ts" file.
  if (base.endsWith(".js")) candidates.splice(1, 0, `${base.slice(0, -3)}.ts`);
  const found = candidates.find((candidate) => sources.has(candidate) && /\.(?:ts|js)$/.test(candidate));
  if (!found) throw new Error(`${from}: Cannot find "${specifier}" in the extension.`);
  return found;
}

/**
 * Strips TypeScript types and turns ES modules into CommonJS with Sucrase,
 * without type checking. Output keeps the source's line numbers. Imports used
 * only as types are removed; dynamic `import()` is kept so the linker can
 * refuse it.
 */
function transpile(sucrase: Sucrase, path: string, source: string): string {
  try {
    return sucrase.transform(source, {
      transforms: path.endsWith(".ts") ? ["typescript", "imports"] : ["imports"],
      filePath: path,
      disableESTransforms: true,
      preserveDynamicImport: true,
    }).code;
  } catch (error) {
    const loc = (error as { loc?: { line: number; column: number } }).loc;
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/^Error transforming [^:]*: /, "")
      .replace(/ \(\d+:\d+\)$/, "");
    throw new Error(loc ? `${path}:${loc.line}:${loc.column + 1}: ${message}` : `${path}: ${message}`, { cause: error });
  }
}

/**
 * The relative files one transpiled module requires. Every static import,
 * re-export and import-equals is a literal `require` once Sucrase has run;
 * a `require` the author wrote must name one literal path, and dynamic
 * `import()` is refused.
 */
function requiredSpecifiers(acorn: Acorn, path: string, code: string): string[] {
  let program: AcornNode;
  try {
    program = acorn.parse(code, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowHashBang: true }) as unknown as AcornNode;
  } catch (error) {
    const loc = (error as { loc?: { line: number; column: number } }).loc;
    const message = (error instanceof Error ? error.message : String(error)).replace(/ \(\d+:\d+\)$/, "");
    throw new Error(loc ? `${path}:${loc.line}:${loc.column + 1}: ${message}` : `${path}: ${message}`, { cause: error });
  }
  const specifiers: string[] = [];
  const visit = (node: AcornNode): void => {
    if (node.type === "ImportExpression") throw new Error(`${path}: Dynamic import() is not supported. Use a static import.`);
    if (node.type === "CallExpression") {
      const callee = node.callee as AcornNode;
      if (callee.type === "Identifier" && callee.name === "require") {
        const args = node.arguments as AcornNode[];
        if (args.length !== 1) throw new Error(`${path}: require() takes one path.`);
        const [argument] = args;
        if (argument!.type !== "Literal" || typeof argument!.value !== "string") throw new Error(`${path}: Import paths must be string literals.`);
        specifiers.push(argument!.value);
      }
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof (child as AcornNode).type === "string") visit(child as AcornNode);
      } else if (value && typeof value === "object" && typeof (value as AcornNode).type === "string") {
        visit(value as AcornNode);
      }
    }
  };
  visit(program);
  return specifiers;
}

/**
 * Links an extension entry with every file it imports, for the platform whose
 * `symbols` its platform directives see: inactive lines are blanked first, so
 * their imports are never followed. TypeScript is transpiled without type
 * checking; only relative imports inside the package resolve.
 */
export async function linkExtensionModules(
  files: readonly ExtensionCodeFile[],
  entry: string,
  symbols: ReadonlySet<PlatformSymbol>,
): Promise<ExtensionModuleBundle> {
  // Loaded only when extension code is linked, never with the editor route.
  const [sucrase, acorn] = await Promise.all([import("sucrase"), import("acorn")]);
  const sources = new Map(files.map((file) => [file.path, file.source]));
  if (!/\.(?:ts|js)$/.test(entry)) throw new Error("Extension entries must be JavaScript (.js) or TypeScript (.ts) files.");
  if (!sources.has(entry)) throw new Error(`Extension entry is missing: ${entry}`);
  const modules: ExtensionModule[] = [];
  const queue = [entry];
  const linked = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (linked.has(path)) continue;
    linked.add(path);
    const code = transpile(sucrase, path, applyPlatformDirectives(sources.get(path)!, symbols, path));
    const imports: Record<string, string> = {};
    for (const specifier of requiredSpecifiers(acorn, path, code)) {
      const target = resolveImport(path, specifier, sources);
      imports[specifier] = target;
      if (target !== EXTENSION_HOST_MODULE) queue.push(target);
    }
    modules.push({ path, code, imports });
  }
  return { entry, modules };
}
