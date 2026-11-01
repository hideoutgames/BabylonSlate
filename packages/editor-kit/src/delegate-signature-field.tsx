import type { DelegateSignatureType } from "@haptic/core";
import { Button } from "@haptic/ui/components/button";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { SearchDropdown } from "./search-dropdown";
import { TypeColorMark } from "./type-color-mark";
import { pinPickerColorVar } from "./pin-types";

/** One signature a Delegate type can take: an Event Dispatcher's inputs. */
export type DelegateSignatureEntry = {
  /** Stored as the Delegate's `typeClassId` (`<classId>::<dispatcher name>`). */
  id: string;
  /** The dispatcher's name. */
  label: string;
  /** The Class declaring it. */
  description?: string;
  signature: readonly DelegateSignatureType[];
  /** The dispatcher's input names, for copying its signature onto another member. */
  parameterNames?: readonly string[];
};

/** What a Delegate row stores for its signature. */
export type DelegateSignatureValue = {
  typeClassId?: string;
  signature?: readonly DelegateSignatureType[];
};

const NO_INPUTS = "__no-inputs__";

/** The patch a Signature pick stores: the dispatcher it names and a copy of its inputs. */
export function delegateSignaturePatch(
  entries: readonly DelegateSignatureEntry[],
  id: string,
): { typeClassId: string | undefined; signature: DelegateSignatureType[] } {
  const entry = id === NO_INPUTS ? undefined : entries.find((candidate) => candidate.id === id);
  return entry
    ? { typeClassId: entry.id, signature: entry.signature.map((input) => ({ ...input })) }
    : { typeClassId: undefined, signature: [] };
}

/** `On Damaged (Enemy)`, or No Inputs, as the Signature field shows it. */
export function delegateSignatureLabel(
  entries: readonly DelegateSignatureEntry[],
  value: DelegateSignatureValue,
): string {
  const entry = entries.find((candidate) => candidate.id === value.typeClassId);
  if (entry) return entry.description ? `${entry.label} (${entry.description})` : entry.label;
  const source = value.typeClassId?.split("::");
  if (source && source.length === 2 && source[1]) return `${source[1]} (${source[0]})`;
  return (value.signature?.length ?? 0) > 0 ? "Custom" : "No Inputs";
}

/**
 * Signature of a Delegate type: picks the Event Dispatcher whose inputs it
 * takes, or No Inputs. The pick is copied onto the row so its pins need no
 * lookup.
 */
export function DelegateSignatureField({
  entries,
  value,
  onChange,
  disabled = false,
  id,
  "data-testid": testId = "delegate-signature",
}: {
  entries: readonly DelegateSignatureEntry[];
  value: DelegateSignatureValue;
  onChange: (patch: { typeClassId: string | undefined; signature: DelegateSignatureType[] }) => void;
  disabled?: boolean;
  id?: string;
  "data-testid"?: string;
}) {
  return (
    <Field className="min-w-32 flex-1">
      <FieldLabel htmlFor={id}>Signature</FieldLabel>
      <SearchDropdown
        title="Signature"
        placeholder="Search Event Dispatchers"
        items={[
          { id: NO_INPUTS, label: "No Inputs", pinned: true },
          ...entries.map((entry) => ({
            id: entry.id,
            label: entry.label,
            description: entry.description,
            leading: <TypeColorMark colorVar={pinPickerColorVar("delegate")} shape="square" />,
          })),
        ]}
        onSelect={(picked) => onChange(delegateSignaturePatch(entries, picked))}
        data-testid={`${testId}-picker`}
      >
        <Button
          id={id}
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-auto min-h-7 justify-start"
          data-testid={testId}
        >
          {delegateSignatureLabel(entries, value)}
        </Button>
      </SearchDropdown>
    </Field>
  );
}
