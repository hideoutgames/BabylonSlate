import {
  PARTICLE_BASIC_BINDINGS_MAX,
  PARTICLE_BASIC_BINDING_TARGETS,
  PARTICLE_BASIC_BINDING_TARGET_IDS,
  type ParticleBasicBinding,
  type ParticleBasicBindingTarget,
} from "@haptic/assets";
import { EntryListEditor, PropertyGrid, type PropertyRow } from "@haptic/editor-kit";
import { normalizeParticleParameterName } from "@haptic/particle-graph";
import { particleParameterValueRow } from "../lib/particle-parameter-rows";

function uniqueName(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) if (!taken.has(`${base} ${index}`)) return `${base} ${index}`;
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
