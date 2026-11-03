import { useState } from "react";
import {
  PARTICLE_BASIC_BINDINGS_MAX,
  PARTICLE_BASIC_BINDING_TARGETS,
  PARTICLE_BASIC_BINDING_TARGET_IDS,
  type ParticleBasicBinding,
  type ParticleBasicBindingTarget,
} from "@haptic/assets";
import { EntryListEditor, PropertyGrid, type PropertyRow } from "@haptic/editor-kit";
import {
  PARTICLE_PARAMETER_NAME_MAX,
  PARTICLE_VALUE_TYPE_OPTIONS,
  normalizeParticleParameterName,
  resizeParticleValue,
  syncParameterNodeTypes,
  type ParticleGraphDocument,
  type ParticleGraphParameter,
  type ParticleNumericType,
} from "@haptic/particle-graph";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { particleParameterValueRow } from "../lib/particle-parameter-rows";

function uniqueName(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) if (!taken.has(`${base} ${index}`)) return `${base} ${index}`;
}

function newParameterId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `param-${Date.now()}-${Math.random()}`;
}

/**
 * Particle Graph Inspector **Parameters** (nothing or the Emitter Output selected): add, rename, retype and delete a graph's parameters and edit
 * their defaults. Retyping resizes the default and retypes the Parameter nodes. Deleting a
 * parameter that nodes use asks first and leaves those nodes in error.
 */
export function ParticleGraphParametersEditor({
  document,
  onChange,
}: {
  document: ParticleGraphDocument;
  onChange: (next: ParticleGraphDocument, mergeKey?: string) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<ParticleGraphParameter[] | null>(null);
  const parameters = document.parameters ?? [];
  const commit = (next: ParticleGraphParameter[], mergeKey?: string) =>
    onChange({ ...document, parameters: next, nodes: syncParameterNodeTypes(document.nodes, next) }, mergeKey);
  const usedIds = new Set(document.nodes.filter((node) => node.type === "input.parameter").map((node) => String(node.properties.parameterId ?? "")));
  const removedInUse = (next: readonly ParticleGraphParameter[]) => {
    const kept = new Set(next.map((parameter) => parameter.id));
    return parameters.filter((parameter) => !kept.has(parameter.id) && usedIds.has(parameter.id));
  };
  const rows = (parameter: ParticleGraphParameter, update: (value: ParticleGraphParameter) => void): PropertyRow[] => [
    {
      id: `parameter-${parameter.id}-name`,
      kind: "text",
      label: "Name",
      value: parameter.name,
      description: `Gameplay sets it by this name. Unique in the graph, up to ${PARTICLE_PARAMETER_NAME_MAX} characters.`,
      onChange: () => undefined,
      onCommit: (text) => {
        const name = normalizeParticleParameterName(text);
        if (!name || parameters.some((other) => other.id !== parameter.id && other.name === name)) return;
        update({ ...parameter, name });
      },
    },
    {
      id: `parameter-${parameter.id}-type`,
      kind: "enum",
      label: "Type",
      value: parameter.type,
      options: PARTICLE_VALUE_TYPE_OPTIONS.map((option) => ({ value: option.id, label: option.label })),
      onChange: (type) => update({ ...parameter, type: type as ParticleNumericType,
        defaultValue: resizeParticleValue(parameter.defaultValue, type as ParticleNumericType) }),
    },
    particleParameterValueRow({
      id: `parameter-${parameter.id}-default`,
      label: "Default",
      type: parameter.type,
      value: parameter.defaultValue,
      onChange: (defaultValue) => update({ ...parameter, defaultValue }),
    }),
  ];
  return (
    <>
      <EntryListEditor
        items={parameters}
        getItemKey={(parameter) => parameter.id}
        onChange={(next) => {
          if (removedInUse(next).length) setPendingDelete(next);
          else commit(next);
        }}
        onCreate={(): ParticleGraphParameter => ({
          id: newParameterId(),
          name: uniqueName(new Set(parameters.map((parameter) => parameter.name)), "Parameter"),
          type: "float",
          defaultValue: [1],
        })}
        addLabel="Add Parameter"
        countNoun={{ one: "parameter", other: "parameters" }}
        renderItem={({ item, onChange: update }) => <PropertyGrid density="compact" rows={rows(item, update)} />}
        data-testid="particle-graph-parameters"
      />
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Parameter</AlertDialogTitle>
            <AlertDialogDescription>
              {`${pendingDelete ? removedInUse(pendingDelete).map((parameter) => parameter.name).join(", ") : ""} is used by Parameter nodes. They stay in the graph and show an error until you delete them.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="particle-graph-parameter-delete-confirm"
              onClick={() => {
                if (pendingDelete) commit(pendingDelete);
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Preview-only parameter values (Preview panels): one field per parameter, starting at its
 * default. They reach the running preview at once and are never saved.
 */
export function ParticlePreviewParameters({
  parameters,
  values,
  onChange,
}: {
  parameters: readonly { name: string; type: ParticleNumericType; defaultValue: readonly number[] }[];
  values: Readonly<Record<string, readonly number[]>>;
  onChange: (values: Record<string, number[]>) => void;
}) {
  if (!parameters.length) return null;
  const rows = parameters.map((parameter) => particleParameterValueRow({
    id: `preview-parameter-${parameter.name}`,
    label: parameter.name,
    type: parameter.type,
    value: values[parameter.name] ?? parameter.defaultValue,
    defaultValue: parameter.defaultValue,
    onChange: (value) => onChange({ ...Object.fromEntries(Object.entries(values).map(([name, entry]) => [name, [...entry]])), [parameter.name]: value }),
  }));
  return (
    <div className="max-h-48 shrink-0 overflow-y-auto border-t border-border" data-testid="particle-preview-parameters">
      <PropertyGrid title="Preview Parameters" rows={rows} />
    </div>
  );
}

/**
 * Basic emitter **Parameters**: each row binds one fixed target to a parameter name, with the
 * default the emitter uses when nothing sets it. One binding per target.
 */
export function ParticleBasicBindingsEditor({
  bindings,
  onChange,
}: {
  bindings: readonly ParticleBasicBinding[];
  onChange: (bindings: ParticleBasicBinding[]) => void;
}) {
  const used = new Set(bindings.map((binding) => binding.target));
  const rows = (binding: ParticleBasicBinding, update: (value: ParticleBasicBinding) => void): PropertyRow[] => {
    const spec = PARTICLE_BASIC_BINDING_TARGETS[binding.target];
    return [
      {
        id: `binding-${binding.target}-target`,
        kind: "enum",
        label: "Target",
        value: binding.target,
        options: PARTICLE_BASIC_BINDING_TARGET_IDS.map((target) => ({
          value: target,
          label: PARTICLE_BASIC_BINDING_TARGETS[target].label,
          disabled: target !== binding.target && used.has(target),
        })),
        onChange: (target) => {
          const next = PARTICLE_BASIC_BINDING_TARGETS[target as ParticleBasicBindingTarget];
          update({ ...binding, target: target as ParticleBasicBindingTarget,
            defaultValue: next.type === spec.type ? binding.defaultValue : [...next.defaultValue] });
        },
      },
      {
        id: `binding-${binding.target}-name`,
        kind: "text",
        label: "Parameter Name",
        value: binding.parameterName,
        onChange: () => undefined,
        onCommit: (text) => {
          const name = normalizeParticleParameterName(text);
          if (name) update({ ...binding, parameterName: name });
        },
      },
      particleParameterValueRow({
        id: `binding-${binding.target}-default`,
        label: "Default",
        type: spec.type,
        value: binding.defaultValue,
        defaultValue: spec.defaultValue,
        onChange: (defaultValue) => update({ ...binding, defaultValue }),
      }),
    ];
  };
  return (
    <EntryListEditor<ParticleBasicBinding>
      items={bindings}
      getItemKey={(binding) => binding.target}
      onChange={onChange}
      onCreate={() => {
        const target = PARTICLE_BASIC_BINDING_TARGET_IDS.find((entry) => !used.has(entry)) ?? "spawn.rateScale";
        return { target, parameterName: uniqueName(new Set(bindings.map((binding) => binding.parameterName)), "Intensity"),
          defaultValue: [...PARTICLE_BASIC_BINDING_TARGETS[target].defaultValue] };
      }}
      maxItems={Math.min(PARTICLE_BASIC_BINDINGS_MAX, PARTICLE_BASIC_BINDING_TARGET_IDS.length)}
      addLabel="Add Binding"
      countNoun={{ one: "binding", other: "bindings" }}
      renderItem={({ item, onChange: update }) => <PropertyGrid density="compact" rows={rows(item, update)} />}
      data-testid="particle-emitter-bindings"
    />
  );
}
