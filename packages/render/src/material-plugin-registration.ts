import { EngineStore, RegisterMaterialPlugin, type PluginMaterialFactory } from "@babylonjs/core";

const registered = new Map<string, PluginMaterialFactory>();

/**
 * Registers a global material plugin factory that survives the last Engine's disposal.
 *
 * Babylon 9.29 unregisters every global factory when the Engine count reaches zero:
 * the homepage Engine unmounting before the project's exists, a project closing, a
 * lone conversion NullEngine. Factories run only as a Material is constructed, so
 * materials built for the next Engine would silently lack the plugin. That cleanup
 * is an `OnEnginesDisposedObservable` observer added when `@babylonjs/core` loads.
 * The observer below is added later, so it is notified later in the same
 * notification and restores the factories before any material can be built.
 * Babylon then clears the observable, removing its own cleanup with it, so one
 * restoration suffices. Registration is keyed by name: repeating it replaces the
 * factory and never attaches a plugin twice.
 *
 * Covers every Engine creation path (editor, Play, player, conversions, proofs)
 * without touching any of them. Recheck on a Babylon upgrade; `texture-quality.test.ts`
 * disposes the last Engine twice.
 */
export function registerPersistentMaterialPlugin(name: string, factory: PluginMaterialFactory): void {
  registered.set(name, factory);
  RegisterMaterialPlugin(name, factory);
}

EngineStore.OnEnginesDisposedObservable.add(() => {
  for (const [name, factory] of registered) RegisterMaterialPlugin(name, factory);
});
