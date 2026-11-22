import type { CompiledModuleSource, ExtensionGameLibrary, ExtensionLibraries } from "@haptic/core";

export type { CompiledModuleSource } from "@haptic/core";

/** Function constructor wrapper (two lines), then the strict directive. */
export const COMPILED_MODULE_LINE_OFFSET = 3;

export interface CompiledModuleExports {
  run?: (...args: unknown[]) => unknown;
  onTick?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

/** Where a loaded script's source sits, when it is not its own `haptic:///<label>.js` source. */
export interface ScriptSourceLocation {
  /** The URL stack frames give the file that holds it. */
  url: string;
  /** The file's line holding the source's first line; columns are the source's own. */
  firstLine: number;
}

/**
 * How a runtime turns compiled Logic Graphs and Extension libraries into code it can call. Editor Play compiles their
 * source text (`functionModuleLoader`, live recompilation); an exported game takes them from its static scripts module
 * (`createStaticModuleLoader`), so it never evaluates text (no `eval` or `new Function`).
 */
export interface ScriptModuleLoader {
  loadScript(script: CompiledModuleSource & { assetGuid: string; classId: string }, label: string, extensions: ExtensionLibraries): Promise<CompiledModuleExports>;
  loadExtensions(libraries: readonly ExtensionGameLibrary[], onError: (error: Error) => void): Promise<ExtensionLibraries>;
  /** Null when stack frames name the script by its own `haptic:///<label>.js` source. */
  sourceLocation(label: string): ScriptSourceLocation | null;
}
