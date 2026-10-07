import type { ActorComponent } from "@babylonslate/object-model";
import type { DynamicRuntimeMeshSync } from "./dynamic-runtime-mesh";
import type { MovementWorldSync } from "./movement";
import type { Painter2DRuntime } from "./painter2d-runtime";
import type { ScriptHostServices } from "./script-host";
import type { Text2DAppearRuntime } from "./text2d-appear-runtime";
import type { UIControls2DRuntime } from "./ui-controls2d-runtime";

interface ComponentHostDeps {
  painters: Pick<Painter2DRuntime, "execute">;
  uiControls: Pick<UIControls2DRuntime, "invoke">;
  dynamicMeshes: Pick<DynamicRuntimeMeshSync, "invoke">;
  movement: Pick<MovementWorldSync, "invoke">;
  textAppear: Pick<Text2DAppearRuntime, "progress" | "execute">;
  /** A tick is running; its end flushes painter and text reveal changes. */
  processingTick(): boolean;
  flushPainters(): void;
  flushTextAppear(): void;
  refreshComponent(component: ActorComponent, propertyName?: string): void;
}

/**
 * Script component function calls: 2D painters, UI controls, dynamic meshes,
 * movement, text reveal and property refreshes. Painter and reveal changes
 * made outside a tick are sent at once.
 */
export function createComponentHostBindings(deps: ComponentHostDeps): Pick<ScriptHostServices,
  "paint2D" | "uiControlFunction" | "dynamicMeshFunction" | "movementFunction" |
  "text2DAppearProgress" | "text2DAppear" | "refreshComponent"> {
  return {
    paint2D: (component, operation, args) => {
      const changed = deps.painters.execute(component, operation, args);
      if (!deps.processingTick()) deps.flushPainters();
      return changed;
    },
    uiControlFunction: (component, name, args) => deps.uiControls.invoke(component, name, args),
    dynamicMeshFunction: (component, name, args) => deps.dynamicMeshes.invoke(component, name, args),
    movementFunction: (component, name, args) => deps.movement.invoke(component, name, args),
    text2DAppearProgress: (component) => deps.textAppear.progress(component),
    text2DAppear: (component, operation) => {
      deps.textAppear.execute(component, operation);
      if (!deps.processingTick()) deps.flushTextAppear();
    },
    refreshComponent: (component, propertyName) => deps.refreshComponent(component, propertyName),
  };
}
