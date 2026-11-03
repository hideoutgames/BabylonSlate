import { useContext } from "react";
import { PropertyGrid, type PropertyRow } from "@haptic/editor-kit";
import type { PinDefaultEditorRequest } from "@haptic/graph-ui";
import { ClassMaterialsContext } from "../context/class-materials-context";
import { materialParameterPinTypes } from "../lib/material-parameter-pin-types";
import { useMaterialParameterNames } from "../lib/use-material-parameter-names";

/**
 * The Name pin of a Set, Get or Reset Material Parameter node: a list of the parameters of the
 * node's type that the Class's mesh components' Materials declare. A name the list lacks stays
 * selected and is marked; without any known parameter the pin is free text.
 */
export function MaterialParameterNamePin({ request }: { request: PinDefaultEditorRequest }) {
  const materials = useContext(ClassMaterialsContext);
  const parameters = useMaterialParameterNames(materials);
  const types = materialParameterPinTypes(request) ?? [];
  const names = [...new Set([...parameters.values()].flat()
    .filter((parameter) => types.includes(parameter.type)).map((parameter) => parameter.name))].sort();
  const value = typeof request.value === "string" ? request.value : "";
  const id = `${request.nodeId}:${request.pin.id}`;
  const row: PropertyRow = names.length
    ? {
        id, kind: "enum", label: request.pin.name, value,
        options: [
          ...(value && !names.includes(value) ? [{ value, label: `${value} (Not Declared)` }] : []),
          ...names.map((name) => ({ value: name, label: name })),
        ],
        onChange: (next) => { if (!request.disabled) request.onChange(next); },
      }
    : {
        id, kind: "text", label: request.pin.name, value,
        onChange: () => undefined,
        onCommit: (next) => { if (!request.disabled) request.onChange(next); },
      };
  return (
    <div className="min-w-24 max-w-(--graph-pin-default-max-width)" data-testid={`material-parameter-name-${request.nodeId}`}>
      <PropertyGrid rows={[row]} hideLabels density="compact" orientation="horizontal" readOnly={request.disabled} />
    </div>
  );
}
