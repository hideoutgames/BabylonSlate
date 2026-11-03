import { normalizeParticleParameterValues, type ParticleSystemParameter } from "@haptic/assets";
import type { SerializedComponent } from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import { Checkbox } from "@haptic/ui/components/checkbox";
import { rowId, type ComponentPropertyUpdate } from "./component-property-row-helpers";
import { particleParameterValueRow } from "./particle-parameter-rows";

/**
 * Particle component **Parameters**: one row per parameter its Particle System declares, showing
 * this component's override or, without one, the System's default. Editing a value overrides it
 * (`parameterOverrides`); clearing the row's Override box goes back to the default. Overrides
 * for names the System no longer declares are kept, so switching the System back restores them.
 */
export function particleParameterOverrideRows(
  actorId: string,
  component: SerializedComponent,
  parameters: readonly ParticleSystemParameter[],
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  const overrides = normalizeParticleParameterValues(component.properties.parameterOverrides);
  const write = (next: Record<string, number[]>) => update("parameterOverrides", next);
  return parameters.map((parameter) => {
    const overridden = parameter.name in overrides;
    const row = particleParameterValueRow({
      id: rowId(actorId, component.id, `parameter-${parameter.name}`),
      label: parameter.name,
      type: parameter.type,
      value: overrides[parameter.name] ?? parameter.defaultValue,
      defaultValue: parameter.defaultValue,
      onChange: (value) => write({ ...overrides, [parameter.name]: value }),
    });
    const toggle = (
      <Checkbox
        aria-label={`Override ${parameter.name}`}
        checked={overridden}
        data-testid={`particle-parameter-override-${parameter.name}`}
        onCheckedChange={(checked) => {
          const next = { ...overrides };
          if (checked) next[parameter.name] = [...parameter.defaultValue];
          else delete next[parameter.name];
          write(next);
        }}
      />
    );
    return { ...row, labelAccessory: toggle } as PropertyRow;
  });
}
