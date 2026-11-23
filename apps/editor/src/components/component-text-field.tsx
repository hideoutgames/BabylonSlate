import { MultilineTextField } from "@haptic/editor-kit";
import { Field } from "@haptic/ui/components/field";
import { useTextEditorTab } from "../lib/use-text-editor-tab";

/**
 * A 3D Text, 2D Text or 2D Rich Text component's **Text** in the Scene and
 * Class / Prefab Inspectors: edited in place, or full size in a Text Editor tab.
 * Hosts key it by the component (and actor), so a selection change remounts it.
 */
export function ComponentTextField({ fieldKey, id, markup = false, value, disabled, onChange }: {
  /** The property within its document, e.g. `component:<actor>:<component>:text`. */
  fieldKey: string;
  /** The inline editor's id; also the field's test id. */
  id: string;
  /** 2D Rich Text: markup completion. */
  markup?: boolean;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const openInTab = useTextEditorTab({
    fieldKey,
    title: "Text",
    mode: markup ? "markup" : "text",
    value,
    onChange,
    disabled,
  });
  return (
    <Field>
      <MultilineTextField
        id={id}
        label="Text"
        markup={markup}
        disabled={disabled}
        value={value}
        onChange={onChange}
        onOpenInTab={openInTab}
        data-testid={id}
      />
    </Field>
  );
}
