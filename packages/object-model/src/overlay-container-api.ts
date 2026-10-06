import { isVirtualizedOverlayClass } from "@babylonslate/core";
import type { EngineScriptVariable } from "./engine-script-api";

export function overlayContainerScriptVariables(classId: string): EngineScriptVariable[] {
  if (isVirtualizedOverlayClass(classId)) return [
    { name: "Item Class", typeId: "class", typeClassId: "SceneLayerActor", propertyKey: "itemClassId" },
    ...["itemCount", "columns", "overscan"].map(propertyKey => ({ name: label(propertyKey), typeId: "int", propertyKey })),
    ...["itemWidth", "itemHeight"].map(propertyKey => ({ name: label(propertyKey), typeId: "float", propertyKey })),
  ];
  if (classId === "2DSafeAreaComponent") return [
    ...["useSafeArea", "safeLeft", "safeRight", "safeTop", "safeBottom"].map(propertyKey => ({ name: label(propertyKey), typeId: "bool", propertyKey })),
    ...["insetLeft", "insetRight", "insetTop", "insetBottom"].map(propertyKey => ({ name: label(propertyKey), typeId: "float", propertyKey })),
  ];
  return [];
}
const label = (property: string) => property.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase());
