import type { AssetDocument } from "@babylonslate/assets";
import type { GlslToMaterialOptions, GlslToMaterialResult } from "@babylonslate/shader-graph";

export interface EditorExtensionEntry {
  id: string;
  path: string;
  source: string;
}

export interface EditorExtensionField {
  id: string;
  label: string;
  type: "text" | "multiline";
  defaultValue?: string;
  required?: boolean;
}

export interface EditorExtensionCommand {
  id: string;
  title: string;
  description?: string;
  fields?: readonly EditorExtensionField[];
  execute(values: Record<string, string>): Promise<void> | void;
}

export interface EditorExtensionCommandDescriptor {
  extensionId: string;
  id: string;
  title: string;
  description?: string;
  fields: readonly EditorExtensionField[];
}

export interface EditorExtensionServices {
  assets: {
    list(): Promise<{ path: string; type: string; name: string; guid: string }[]>;
    read(path: string): Promise<AssetDocument>;
    create(path: string, document: Pick<AssetDocument, "type" | "name" | "payload">): Promise<void>;
    update(path: string, document: AssetDocument): Promise<void>;
  };
  code: {
    read(path: string): Promise<string>;
    write(path: string, source: string): Promise<void>;
  };
  materials: {
    convertGlsl(source: string, options?: GlslToMaterialOptions): GlslToMaterialResult | Promise<GlslToMaterialResult>;
  };
  log?(extensionId: string, message: string): void;
}

export interface EditorExtensionApi {
  assets: EditorExtensionServices["assets"];
  code: EditorExtensionServices["code"];
  materials: EditorExtensionServices["materials"];
  registerCommand(command: EditorExtensionCommand): () => void;
  log(message: string): void;
}

export interface EditorExtensionDiagnostic {
  extensionId: string;
  phase: "activate" | "command" | "dispose";
  message: string;
}

type Cleanup = () => void | Promise<void>;
type RegisteredCommand = EditorExtensionCommandDescriptor & Pick<EditorExtensionCommand, "execute">;

interface ExtensionState {
  id: string;
  alive: boolean;
  ready: boolean;
  commands: Map<string, RegisteredCommand>;
  operations: Set<Promise<unknown>>;
  cleanup?: Cleanup;
}

async function evaluateExtension(entry: EditorExtensionEntry): Promise<(api: EditorExtensionApi) => unknown> {
  if (!/\.(?:js|ts)$/i.test(entry.path)) {
    throw new Error("Extension entries must be JavaScript (.js) or TypeScript (.ts) files.");
  }
  // Loaded only when extensions are enabled. The same parser handles JavaScript
  // exports and TypeScript syntax without rewriting source with regular expressions.
  const ts = await import("typescript");
  const sourceFile = ts.createSourceFile(entry.path, entry.source, ts.ScriptTarget.ES2022, true);
  const checkImports = (node: import("typescript").Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)
      || (ts.isExportDeclaration(node) && node.moduleSpecifier)
      || (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require")))) {
      throw new Error("Extension entries cannot import or require modules. Use the editor API passed to activate(api).");
    }
    ts.forEachChild(node, checkImports);
  };
  checkImports(sourceFile);
  const result = ts.transpileModule(entry.source, {
    fileName: entry.path,
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
    throw new Error(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"));
  }
  const module = { exports: {} as Record<string, unknown> };
  const requireUnsupported = () => { throw new Error("Extension module imports are not supported."); };
  // Extensions are trusted editor code, not a security sandbox. Runtime exports
  // are explicit so both ESM-transpiled and CommonJS entry points work.
  const evaluate = new Function("exports", "module", "require", `${result.outputText}\n//# sourceURL=${encodeURIComponent(entry.path)}`);
  evaluate(module.exports, module, requireUnsupported);
  const activate = module.exports?.activate;
  if (typeof activate !== "function") {
    throw new Error("Extension entry must export an activate(api) function.");
  }
  return activate as (api: EditorExtensionApi) => unknown;
}

/** Owns commands and API lifetimes for trusted, editor-only extension code. */
export class EditorExtensionHost {
  private readonly services: EditorExtensionServices;
  private readonly states = new Map<string, ExtensionState>();
  private readonly diagnostics: EditorExtensionDiagnostic[] = [];
  private disposed = false;

  constructor(services: EditorExtensionServices) {
    this.services = services;
  }

  listCommands(): EditorExtensionCommandDescriptor[] {
    return [...this.states.values()].filter((state) => state.ready && state.alive)
      .flatMap((state) => [...state.commands.values()].map((command) => ({
        extensionId: command.extensionId,
        id: command.id,
        title: command.title,
        description: command.description,
        fields: command.fields.map((field) => ({ ...field })),
      })));
  }

  getDiagnostics(): EditorExtensionDiagnostic[] {
    return this.diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  async activate(entry: EditorExtensionEntry): Promise<boolean> {
    if (this.disposed) throw new Error("The extension host has been disposed.");
    if (!entry.id.trim()) throw new Error("An extension ID is required.");
    const previous = this.states.get(entry.id);
    const state: ExtensionState = { id: entry.id, alive: true, ready: false, commands: new Map(), operations: new Set() };
    this.states.set(entry.id, state);
    if (previous) await this.disposeState(previous);
    if (!this.isCurrent(state)) return false;
    try {
      const activate = await evaluateExtension(entry);
      if (!this.isCurrent(state)) return false;
      const cleanup = await activate(this.createApi(state));
      if (cleanup !== undefined && typeof cleanup !== "function") {
        throw new Error("activate(api) must return a cleanup function or nothing.");
      }
      state.cleanup = cleanup as Cleanup | undefined;
      if (!this.isCurrent(state)) {
        await this.disposeState(state);
        return false;
      }
      state.ready = true;
      this.clearDiagnostics(state.id, "activate");
      this.clearDiagnostics(state.id, "command");
      return true;
    } catch (error) {
      if (this.isCurrent(state)) {
        this.recordDiagnostic(state, "activate", error);
        this.states.delete(state.id);
      }
      await this.disposeState(state);
      return false;
    }
  }

  async deactivate(extensionId: string): Promise<void> {
    const state = this.states.get(extensionId);
    if (!state) return;
    this.states.delete(extensionId);
    await this.disposeState(state);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const states = [...this.states.values()].reverse();
    this.states.clear();
    // Invalidate every API synchronously before any asynchronous cleanup.
    for (const state of states) {
      state.alive = false;
      state.commands.clear();
    }
    for (const state of states) await this.disposeState(state);
  }

  async run(extensionId: string, commandId: string, values: Record<string, string> = {}): Promise<void> {
    const state = this.states.get(extensionId);
    const command = state?.ready ? state.commands.get(commandId) : undefined;
    if (!state || !command) throw new Error(`Extension command is unavailable: ${extensionId}/${commandId}`);
    this.assertCurrent(state);
    const input = Object.assign(Object.create(null) as Record<string, string>, values);
    for (const value of Object.values(input)) {
      if (typeof value !== "string") throw new Error("Extension command field values must be strings.");
    }
    for (const field of command.fields) {
      input[field.id] ??= field.defaultValue ?? "";
      if (field.required && !input[field.id].trim()) throw new Error(`${field.label} is required.`);
    }
    try {
      await command.execute(input);
      this.assertCurrent(state);
      this.clearDiagnostics(state.id, "command");
    } catch (error) {
      if (this.isCurrent(state)) {
        this.recordDiagnostic(state, "command", error);
      }
      throw error;
    }
  }

  private isCurrent(state: ExtensionState): boolean {
    return state.alive && !this.disposed && this.states.get(state.id) === state;
  }

  private assertCurrent(state: ExtensionState): void {
    if (!this.isCurrent(state)) throw new Error(`Extension ${state.id} is no longer active.`);
  }

  private recordDiagnostic(state: ExtensionState, phase: EditorExtensionDiagnostic["phase"], error: unknown): void {
    this.clearDiagnostics(state.id, phase);
    this.diagnostics.push({ extensionId: state.id, phase, message: error instanceof Error ? error.message : String(error) });
  }

  private clearDiagnostics(extensionId: string, phase: EditorExtensionDiagnostic["phase"]): void {
    for (let index = this.diagnostics.length - 1; index >= 0; index -= 1) {
      if (this.diagnostics[index].extensionId === extensionId && this.diagnostics[index].phase === phase) {
        this.diagnostics.splice(index, 1);
      }
    }
  }

  private async disposeState(state: ExtensionState): Promise<void> {
    state.alive = false;
    state.commands.clear();
    const cleanup = state.cleanup;
    state.cleanup = undefined;
    if (cleanup) {
      try {
        await cleanup();
      } catch (error) {
        this.recordDiagnostic(state, "dispose", error);
      }
    }
    // Project storage may be released/rebound only after already-started API I/O settles.
    await Promise.allSettled([...state.operations]);
  }

  private createApi(state: ExtensionState): EditorExtensionApi {
    const guarded = <T>(action: () => T | Promise<T>): Promise<T> => {
      const pending = (async () => {
        this.assertCurrent(state);
        const result = await action();
        this.assertCurrent(state);
        return result;
      })();
      state.operations.add(pending);
      void pending.then(() => state.operations.delete(pending), () => state.operations.delete(pending));
      return pending;
    };
    return {
      assets: {
        list: () => guarded(() => this.services.assets.list()),
        read: (path) => guarded(() => this.services.assets.read(path)),
        create: (path, document) => guarded(() => this.services.assets.create(path, document)),
        update: (path, document) => guarded(() => this.services.assets.update(path, document)),
      },
      code: {
        read: (path) => guarded(() => this.services.code.read(path)),
        write: (path, source) => guarded(() => this.services.code.write(path, source)),
      },
      materials: {
        convertGlsl: (source, options) => guarded(() => this.services.materials.convertGlsl(source, options)),
      },
      log: (message) => {
        this.assertCurrent(state);
        this.services.log?.(state.id, String(message));
      },
      registerCommand: (command) => {
        this.assertCurrent(state);
        if (!command || typeof command.id !== "string" || !command.id.trim()
          || typeof command.title !== "string" || !command.title.trim() || typeof command.execute !== "function") {
          throw new Error("Extension commands need an ID, a title, and an execute function.");
        }
        if (state.commands.has(command.id)) throw new Error(`Duplicate extension command: ${command.id}`);
        const fields = command.fields?.map((field) => ({ ...field })) ?? [];
        const ids = new Set<string>();
        for (const field of fields) {
          if (typeof field.id !== "string" || !field.id.trim() || typeof field.label !== "string" || !field.label.trim()
            || !["text", "multiline"].includes(field.type) || ids.has(field.id)
            || (field.defaultValue !== undefined && typeof field.defaultValue !== "string")) {
            throw new Error(`Invalid or duplicate command field in ${command.id}.`);
          }
          ids.add(field.id);
        }
        const registered = { ...command, fields, extensionId: state.id };
        state.commands.set(command.id, registered);
        return () => {
          if (state.commands.get(command.id) === registered) state.commands.delete(command.id);
        };
      },
    };
  }
}
