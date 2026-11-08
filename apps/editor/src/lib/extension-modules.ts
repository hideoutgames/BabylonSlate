import type { ExtensionCodeFile } from "@haptic/assets";
import { EXTENSION_HOST_MODULE, type ExtensionModule, type ExtensionModuleBundle } from "@haptic/core";

type TypeScript = typeof import("typescript");

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

/** Value imports of one file. Type-only imports are erased, so they may name anything. */
function valueImports(ts: TypeScript, path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true);
  const specifiers: string[] = [];
  const literal = (node: import("typescript").Expression | undefined): string => {
    if (!node || !ts.isStringLiteralLike(node)) throw new Error(`${path}: Import paths must be string literals.`);
    return node.text;
  };
  const visit = (node: import("typescript").Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly = clause?.isTypeOnly || (clause && !clause.name && clause.namedBindings
        && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) specifiers.push(literal(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        specifiers.push(literal(node.moduleReference.expression));
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && !node.isTypeOnly) specifiers.push(literal(node.moduleSpecifier));
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        throw new Error(`${path}: Dynamic import() is not supported. Use a static import.`);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        if (node.arguments.length !== 1) throw new Error(`${path}: require() takes one path.`);
        specifiers.push(literal(node.arguments[0]));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

function transpile(ts: TypeScript, path: string, source: string): string {
  const result = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleDetection: ts.ModuleDetectionKind.Force,
      isolatedModules: true,
    },
  });
  const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length > 0) {
    throw new Error(errors.map((diagnostic) => {
      const position = diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
      const location = position ? `${path}:${position.line + 1}:${position.character + 1}` : path;
      return `${location}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
    }).join("\n"));
  }
  return result.outputText;
}

/**
 * Links an extension entry with every file it imports. TypeScript is transpiled
 * without type checking; only relative imports inside the package resolve.
 */
export async function linkExtensionModules(files: readonly ExtensionCodeFile[], entry: string): Promise<ExtensionModuleBundle> {
  // Loaded only when extension code is linked, never with the editor route.
  const ts = await import("typescript");
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
    const source = sources.get(path)!;
    const imports: Record<string, string> = {};
    for (const specifier of valueImports(ts, path, source)) {
      const target = resolveImport(path, specifier, sources);
      imports[specifier] = target;
      if (target !== EXTENSION_HOST_MODULE) queue.push(target);
    }
    modules.push({ path, code: transpile(ts, path, source), imports });
  }
  return { entry, modules };
}
