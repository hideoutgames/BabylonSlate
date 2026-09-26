import {
  ArrowLeftRightIcon,
  BlendIcon,
  EqualIcon,
  SplineIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";
import { NestedMenu, type NestedMenuItem } from "./nested-menu";

export type ValueModeOption<M extends string> = {
  value: M;
  label: string;
  icon: LucideIcon;
};

export const VALUE_MODE_CONSTANT = {
  value: "constant",
  label: "Constant",
  icon: EqualIcon,
} as const satisfies ValueModeOption<"constant">;
export const VALUE_MODE_RANGE = {
  value: "range",
  label: "Random Range",
  icon: ArrowLeftRightIcon,
} as const satisfies ValueModeOption<"range">;
export const VALUE_MODE_CURVE = {
  value: "curve",
  label: "Curve",
  icon: SplineIcon,
} as const satisfies ValueModeOption<"curve">;
/** Color curves are gradients; the stored mode stays `"curve"`. */
export const VALUE_MODE_GRADIENT = {
  value: "curve",
  label: "Gradient",
  icon: BlendIcon,
} as const satisfies ValueModeOption<"curve">;

export interface ValueModeFieldProps<M extends string> {
  /** Property name, e.g. "Lifetime". */
  label: string;
  /** The mode type comes from `options`, so state setters work as `onChange`. */
  value: NoInfer<M>;
  options: readonly ValueModeOption<M>[];
  onChange: (mode: NoInfer<M>) => void;
  disabled?: boolean;
  /** Hosts pass `value-mode-<rowId>`. */
  "data-testid"?: string;
}

/**
 * Compact icon menu that picks how a property is authored (Constant, Random
 * Range, Curve or Gradient). Hosts swap the PropertyGrid row kind per mode and
 * place this in the row's `labelAccessory`; with one mode, render nothing.
 */
export function ValueModeField<M extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  "data-testid": testId,
}: ValueModeFieldProps<M>) {
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  const Icon = current.icon;
  const items: NestedMenuItem[] = [
    {
      type: "radio-group",
      id: "value-mode",
      value: current.value,
      onValueChange: (next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option && option.value !== current.value) onChange(option.value);
      },
      items: options.map((option) => ({
        id: option.value,
        label: option.label,
        value: option.value,
        testId: testId ? `${testId}-${option.value}` : undefined,
      })),
    },
  ];

  return (
    <Tooltip>
      <NestedMenu
        items={items}
        align="end"
        contentTestId={testId ? `${testId}-menu` : undefined}
        trigger={
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground aria-expanded:text-foreground pointer-coarse:size-[var(--touch-target)]"
                aria-label={`${label} Value Mode, ${current.label}`}
                disabled={disabled}
                data-testid={testId}
              />
            }
          />
        }
      >
        <Icon aria-hidden="true" />
      </NestedMenu>
      <TooltipContent>Value Mode: {current.label}</TooltipContent>
    </Tooltip>
  );
}
