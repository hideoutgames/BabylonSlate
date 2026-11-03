import { useContext } from "react";
import { PropertyGrid, type PropertyRow } from "@haptic/editor-kit";
import type { PinDefaultEditorRequest } from "@haptic/graph-ui";
import { ClassParticleSystemsContext } from "../context/class-particle-systems-context";
import { PARTICLE_PARAMETER_NAME_TYPES } from "../lib/particle-parameter-name-types";
import { useParticleSystemParameters } from "../lib/use-particle-system-parameters";


/**
 * The Name pin of a particle parameter node acting on Self: a list of the parameters the
 * Class's Particle Systems declare with a matching type. A name the list lacks stays selected
 * and is marked; without any known parameter the pin is free text.
 */
export function ParticleParameterNamePin({ request }: { request: PinDefaultEditorRequest }) {
  const systems = useContext(ClassParticleSystemsContext);
  const parameters = useParticleSystemParameters(systems);
  const types = PARTICLE_PARAMETER_NAME_TYPES[request.nodeType ?? ""];
  const names = [...new Set([...parameters.values()].flat()
    .filter((parameter) => !types || types.includes(parameter.type)).map((parameter) => parameter.name))].sort();
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
    <div className="min-w-24 max-w-(--graph-pin-default-max-width)" data-testid={`particle-parameter-name-${request.nodeId}`}>
      <PropertyGrid rows={[row]} hideLabels density="compact" orientation="horizontal" readOnly={request.disabled} />
    </div>
  );
}
