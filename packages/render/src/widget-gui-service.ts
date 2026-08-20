import { Mesh, type AbstractMesh, type Scene } from "@babylonjs/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { inputModeAllowsGuiHits, parseInputMode } from "@babylonslate/core";
import {
  describeUiControls,
  scopeUiControlIds,
  type UserInterfaceDocument,
} from "@babylonslate/ui-runtime";
import type { UiWidgetEvent } from "./babylon-ui-host";
import { applyUiControls } from "./ui-apply";
import {
  attachMeshGui,
  resolveWidgetBitmapSize,
  type MeshGuiOptions,
} from "./widget-gui";

function playComponentMeshName(slotId: number, componentId: string): string {
  return `actor-${slotId}|${componentId}`;
}

export type WidgetUiLibrary = ReadonlyMap<string, UserInterfaceDocument>;

export type WidgetGuiEvent = {
  instanceId: string;
  widgetId: string;
  kind: UiWidgetEvent["kind"];
  value?: unknown;
};

type LiveGui = {
  instanceId: string;
  slotId: number;
  componentId: string;
  dispose: () => void;
  setAllowGuiHits: (allow: boolean) => void;
  host: { setVisible: (widgetId: string, visible: boolean) => void };
};

function parseScopedControlId(
  id: string,
): { instanceId: string; widgetId: string } | null {
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  return { instanceId: id.slice(0, colon), widgetId: id.slice(colon + 1) };
}

function isWorldUiApply(
  command: CommandMessage,
): command is Extract<CommandMessage, { type: "uiApply" }> & {
  target: { kind: "world"; slotId: number; componentId: string };
} {
  return (
    command.type === "uiApply" &&
    command.target?.kind === "world" &&
    typeof command.target.slotId === "number" &&
    typeof command.target.componentId === "string"
  );
}

/**
 * Main-thread owner of world-space UserInterface ADTs on WidgetComponent planes.
 */
export class WidgetGuiService {
  private readonly scene: Scene;
  private library: WidgetUiLibrary = new Map();
  private readonly slotMeshes = new Map<number, AbstractMesh | null>();
  private readonly live = new Map<string, LiveGui>();
  private allowGuiHits = true;
  private readonly hostOptions: Omit<MeshGuiOptions, "name" | "twoSided" | "bitmap" | "interactive">;
  private readonly onWidgetEvent?: (event: WidgetGuiEvent) => void;

  constructor(options: {
    scene: Scene;
    onWidgetEvent?: (event: WidgetGuiEvent) => void;
    resolveImageUrl?: MeshGuiOptions["resolveImageUrl"];
    resolveInterfaceMaterial?: MeshGuiOptions["resolveInterfaceMaterial"];
    materialFunctions?: MeshGuiOptions["materialFunctions"];
    resolveTexture?: MeshGuiOptions["resolveTexture"];
    materialLibrary?: MeshGuiOptions["materialLibrary"];
    onTouchAxis?: MeshGuiOptions["onTouchAxis"];
  }) {
    this.scene = options.scene;
    this.onWidgetEvent = options.onWidgetEvent;
    this.hostOptions = {
      resolveImageUrl: options.resolveImageUrl,
      resolveInterfaceMaterial: options.resolveInterfaceMaterial,
      materialFunctions: options.materialFunctions,
      resolveTexture: options.resolveTexture,
      materialLibrary: options.materialLibrary,
      onTouchAxis: options.onTouchAxis,
    };
  }

  setLibrary(library: WidgetUiLibrary): void {
    this.library = library;
  }

  bindSlot(slotId: number, mesh: AbstractMesh | null): void {
    this.slotMeshes.set(slotId, mesh);
  }

  handleCommand(command: CommandMessage): boolean {
    if (isWorldUiApply(command)) {
      this.applyWorld(command);
      return true;
    }
    if (command.type === "uiRemove") {
      if (!this.live.has(command.instanceId)) return false;
      this.remove(command.instanceId);
      return true;
    }
    if (command.type === "uiSetVisible") {
      const live = this.live.get(command.instanceId);
      if (!live) return false;
      live.host.setVisible(`${command.instanceId}:${command.widgetId}`, command.visible);
      return true;
    }
    if (command.type === "setInputMode") {
      this.allowGuiHits = inputModeAllowsGuiHits(parseInputMode(command.mode));
      for (const live of this.live.values()) {
        live.setAllowGuiHits(this.allowGuiHits);
      }
      return true;
    }
    return false;
  }

  resetSession(): void {
    for (const live of this.live.values()) live.dispose();
    this.live.clear();
    this.slotMeshes.clear();
    this.allowGuiHits = true;
  }

  dispose(): void {
    this.resetSession();
  }

  private applyWorld(
    command: Extract<CommandMessage, { type: "uiApply" }> & {
      target: { kind: "world"; slotId: number; componentId: string };
    },
  ): void {
    this.remove(command.instanceId);
    const document = this.library.get(command.assetGuid);
    if (!document) return;
    const mesh = this.resolveMesh(command.target.slotId, command.target.componentId);
    if (!mesh) return;
    const bitmap = resolveWidgetBitmapSize(document);
    const twoSided = Boolean(
      (mesh.metadata as { widgetTwoSided?: boolean } | null)?.widgetTwoSided,
    );
    const attached = attachMeshGui(mesh as Mesh, {
      name: `${mesh.name}:gui`,
      twoSided,
      interactive: true,
      allowGuiHits: this.allowGuiHits,
      bitmap,
      ...this.hostOptions,
      onWidgetEvent: (event) => {
        const parsed = parseScopedControlId(event.widgetId);
        if (!parsed) return;
        this.onWidgetEvent?.({
          instanceId: parsed.instanceId,
          widgetId: parsed.widgetId,
          kind: event.kind,
          ...("value" in event ? { value: event.value } : {}),
        });
      },
    });
    const controls = scopeUiControlIds(
      describeUiControls(document, {
        parentSize: bitmap,
        applySafeArea: false,
        resolveNested: (guid) => this.library.get(guid) ?? null,
      }),
      command.instanceId,
    );
    applyUiControls(attached.host, controls);
    this.live.set(command.instanceId, {
      instanceId: command.instanceId,
      slotId: command.target.slotId,
      componentId: command.target.componentId,
      dispose: attached.dispose,
      setAllowGuiHits: attached.setAllowGuiHits,
      host: attached.host,
    });
  }

  private remove(instanceId: string): void {
    const live = this.live.get(instanceId);
    if (!live) return;
    live.dispose();
    this.live.delete(instanceId);
  }

  private resolveMesh(slotId: number, componentId: string): AbstractMesh | null {
    const root = this.slotMeshes.get(slotId);
    if (!root) return null;
    const childName = playComponentMeshName(slotId, componentId);
    const child = this.scene.getMeshByName(childName);
    if (child) return child;
    if (root.name === childName) return root;
    return root;
  }
}
