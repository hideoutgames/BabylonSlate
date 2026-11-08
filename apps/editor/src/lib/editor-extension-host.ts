import {
  normalizeExtensionFields, resolveExtensionFieldValues,
  type AssetDocument, type ExtensionCodeFile, type ExtensionField, type ExtensionFieldValues,
} from "@haptic/assets";
import { evaluateExtensionBundle } from "@haptic/core";
import type { GlslToMaterialOptions, GlslToMaterialResult } from "@haptic/shader-graph";
import { linkExtensionModules } from "./extension-modules";

export interface EditorExtensionEntry {
  id: string;
  /** Display name for errors and source URLs. */
  label?: string;
  /** Package-relative editor entry module. */
  entry: string;
  /** The package's code files; the entry may import them relatively. */
  files: readonly ExtensionCodeFile[];
  /** The extension's Project Settings values when it activates (`api.settings`). */
  settings?: ExtensionFieldValues;
}

export interface EditorExtensionCommand {
  id: string;
  title: string;
  description?: string;
  /** Dialog fields in the declarative schema (`normalizeExtensionFields`). */
  fields?: readonly unknown[];
  /** Receives every field's value, typed by its field; a returned string is shown when it completes. */
  execute(values: ExtensionFieldValues): Promise<string | void> | string | void;
}

export interface EditorExtensionCommandDescriptor {
  extensionId: string;
  id: string;
  title: string;
  description?: string;
  fields: readonly ExtensionField[];
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
  /** This extension's Project Settings values, with field defaults filled in. */
  settings: {
    get(): ExtensionFieldValues;
    /** Calls `listener` after the values change; returns an unsubscribe function. */
    onChange(listener: (values: ExtensionFieldValues) => void): () => void;
  };
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
const EMPTY_VALUES: ExtensionFieldValues = Object.freeze({}) as ExtensionFieldValues;

interface ExtensionState {
  id: string;
  alive: boolean;
  ready: boolean;
  commands: Map<string, RegisteredCommand>;
  operations: Set<Promise<unknown>>;
  cleanup?: Cleanup;
  settings: ExtensionFieldValues;
  settingsListeners: Set<(values: ExtensionFieldValues) => void>;
}

async function evaluateExtension(entry: EditorExtensionEntry): Promise<(api: EditorExtensionApi) => unknown> {
  const bundle = await linkExtensionModules(entry.files, entry.entry);
  // Extensions are trusted editor code, not a security sandbox. Every module is
  // CommonJS after linking, so ESM-transpiled and CommonJS entries both work.
  const exports = evaluateExtensionBundle(bundle, entry.label ?? entry.id);
  const activate = exports?.activate;
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
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(services: EditorExtensionServices) {
    this.services = services;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notifyChange(): void {
    for (const listener of this.listeners) listener();
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
    const state: ExtensionState = {
      id: entry.id, alive: true, ready: false, commands: new Map(), operations: new Set(),
      settings: Object.freeze({ ...(entry.settings ?? EMPTY_VALUES) }), settingsListeners: new Set(),
    };
    this.states.set(entry.id, state);
    if (previous) {
      this.notifyChange();
      await this.disposeState(previous);
    }
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
      this.notifyChange();
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

  /** New Project Settings values for an active extension; its `api.settings` listeners run when they differ. */
  updateSettings(extensionId: string, values: ExtensionFieldValues): void {
    const state = this.states.get(extensionId);
    if (!state || !this.isCurrent(state)) return;
    if (JSON.stringify(state.settings) === JSON.stringify(values)) return;
    state.settings = Object.freeze({ ...values });
    for (const listener of [...state.settingsListeners]) {
      try {
        listener(state.settings);
      } catch (error) {
        this.recordDiagnostic(state, "command", error);
      }
    }
  }

  async deactivate(extensionId: string): Promise<void> {
    const state = this.states.get(extensionId);
    if (!state) return;
    this.states.delete(extensionId);
    this.notifyChange();
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
    if (states.length > 0) this.notifyChange();
    for (const state of states) await this.disposeState(state);
  }

  /** Runs a command; resolves to the message it returned, if any. */
  async run(extensionId: string, commandId: string, values: Readonly<Record<string, unknown>> = {}): Promise<string | undefined> {
    const state = this.states.get(extensionId);
    const command = state?.ready ? state.commands.get(commandId) : undefined;
    if (!state || !command) throw new Error(`Extension command is unavailable: ${extensionId}/${commandId}`);
    this.assertCurrent(state);
    // Each field gets a value of its own type; anything else falls back to the field default.
    const input = Object.assign(Object.create(null) as ExtensionFieldValues, resolveExtensionFieldValues(command.fields, values));
    for (const field of command.fields) {
      if (field.required && typeof input[field.id] === "string" && !(input[field.id] as string).trim()) throw new Error(`${field.label} is required.`);
    }
    try {
      const result = await command.execute(input);
      this.assertCurrent(state);
      if (this.clearDiagnostics(state.id, "command")) this.notifyChange();
      return typeof result === "string" && result.trim() ? result : undefined;
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
    this.notifyChange();
  }

  private clearDiagnostics(extensionId: string, phase: EditorExtensionDiagnostic["phase"]): boolean {
    const previousLength = this.diagnostics.length;
    for (let index = this.diagnostics.length - 1; index >= 0; index -= 1) {
      if (this.diagnostics[index].extensionId === extensionId && this.diagnostics[index].phase === phase) {
        this.diagnostics.splice(index, 1);
      }
    }
    return this.diagnostics.length !== previousLength;
  }

  private async disposeState(state: ExtensionState): Promise<void> {
    state.alive = false;
    state.commands.clear();
    state.settingsListeners.clear();
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
      settings: {
        get: () => {
          this.assertCurrent(state);
          return state.settings;
        },
        onChange: (listener) => {
          this.assertCurrent(state);
          if (typeof listener !== "function") throw new Error("settings.onChange needs a function.");
          state.settingsListeners.add(listener);
          return () => { state.settingsListeners.delete(listener); };
        },
      },
      registerCommand: (command) => {
        this.assertCurrent(state);
        if (!command || typeof command.id !== "string" || !command.id.trim()
          || typeof command.title !== "string" || !command.title.trim() || typeof command.execute !== "function") {
          throw new Error("Extension commands need an ID, a title, and an execute function.");
        }
        if (state.commands.has(command.id)) throw new Error(`Duplicate extension command: ${command.id}`);
        let fields: ExtensionField[];
        try {
          fields = normalizeExtensionFields(command.fields);
        } catch (cause) {
          throw new Error(`Command ${command.id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        }
        const registered = { ...command, fields, extensionId: state.id };
        state.commands.set(command.id, registered);
        if (state.ready) this.notifyChange();
        return () => {
          if (state.commands.get(command.id) === registered) {
            state.commands.delete(command.id);
            if (state.ready) this.notifyChange();
          }
        };
      },
    };
  }
}
