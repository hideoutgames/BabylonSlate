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
  note,
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
  /** Live state the row must show, such as why the setting does not apply. */
  note?: string;
  children: (control: { id: string; disabled: boolean; describedBy?: string }) => ReactNode;
}) {
  const id = `${scope.idPrefix}-${suffix}`;
  const fieldLabel = <FieldLabel htmlFor={id}>{label}</FieldLabel>;
  const labelled = hint ? <LabelHint hint={hint}>{fieldLabel}</LabelHint> : fieldLabel;
  const description = hint ? <FieldDescription id={`${id}-description`} className="sr-only">{hint}</FieldDescription> : null;
  const className = dependent ? "settings-field settings-field-dependent" : "settings-field";
  const noteLine = note ? <FieldDescription id={`${id}-note`} data-testid={`${id}-note`}>{note}</FieldDescription> : null;
  if (!scope.scene) {
    const describedBy = [hint ? `${id}-description` : "", note ? `${id}-note` : ""].filter(Boolean).join(" ");
    return (
      <Field orientation={toggle ? "horizontal" : undefined} className={className}>
        {labelled}
        {children({ id, disabled, describedBy: describedBy || undefined })}
        {description}
        {noteLine}
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
        describedBy: [hint ? `${id}-description` : "", `${id}-status`, note ? `${id}-note` : ""].filter(Boolean).join(" "),
      })}
      {description}
      <FieldDescription id={`${id}-status`}>{status}</FieldDescription>
      {noteLine}
    </Field>
  );
}
