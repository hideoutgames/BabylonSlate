import type { ReactNode } from "react";
import { LabelHint } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@haptic/ui/components/field";
import { readEffect, type EffectsPath, type EffectsScope } from "./render-effects-scope";

function defaultDisplay(value: unknown): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

/**
 * One Post Processing row. In Project Settings a switch sits beside its label;
 * in a Scene every row has Override / Reset To Project, stays disabled until
 * overridden, and states the project value it follows, as the Shadows and
 * Environment Lighting overrides do.
 */
export function EffectRow({
  scope,
  path,
  suffix,
  label,
  hint,
  toggle = false,
  dependent = false,
  disabled = false,
  display = defaultDisplay,
  children,
}: {
  scope: EffectsScope;
  path: EffectsPath;
  /** Id suffix after the scope prefix, such as `bloom-threshold`. */
  suffix: string;
  label: string;
  /** The label's tooltip and the control's screen-reader description. */
  hint?: string;
  /** A switch row. */
  toggle?: boolean;
  /** Indented under the row that enables it. */
  dependent?: boolean;
  /** Disabled in every scope, such as a Scene Linear setting in Legacy Display. */
  disabled?: boolean;
  /** The project value as the Scene status line shows it. */
  display?: (value: unknown) => string;
  children: (control: { id: string; disabled: boolean; describedBy?: string }) => ReactNode;
}) {
  const id = `${scope.idPrefix}-${suffix}`;
  const fieldLabel = <FieldLabel htmlFor={id}>{label}</FieldLabel>;
  const labelled = hint ? <LabelHint hint={hint}>{fieldLabel}</LabelHint> : fieldLabel;
  const description = hint ? <FieldDescription id={`${id}-description`} className="sr-only">{hint}</FieldDescription> : null;
  const className = dependent ? "settings-field settings-field-dependent" : "settings-field";
  if (!scope.scene) {
    return (
      <Field orientation={toggle ? "horizontal" : undefined} className={className}>
        {labelled}
        {children({ id, disabled, describedBy: hint ? `${id}-description` : undefined })}
        {description}
      </Field>
    );
  }
  const overridden = scope.scene.overridden(path);
  const status = `${overridden ? "Scene Override · Project" : "Project Setting"}: ${display(readEffect(scope.scene.project, path))}.`;
  return (
    <Field className={className} data-disabled={!overridden || undefined}>
      <div className="flex items-center justify-between gap-2">
        {labelled}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${overridden ? "Reset" : "Override"} ${label}`}
          data-testid={`${id}-override`}
          onClick={() => scope.scene?.toggle(path)}
        >
          {overridden ? "Reset To Project" : "Override"}
        </Button>
      </div>
      {children({
        id,
        disabled: disabled || !overridden,
        describedBy: [hint ? `${id}-description` : "", `${id}-status`].filter(Boolean).join(" "),
      })}
      {description}
      <FieldDescription id={`${id}-status`}>{status}</FieldDescription>
    </Field>
  );
}
