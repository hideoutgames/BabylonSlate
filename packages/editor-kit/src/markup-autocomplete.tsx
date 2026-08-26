import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Textarea } from "@babylonslate/ui/components/textarea";
import { SearchDropdown } from "./search-dropdown";

export type MarkupSuggestion = {
  id: string;
  label: string;
  description?: string;
  group?: string;
};

export type MarkupAutocompleteSession = {
  replaceFrom: number;
  replaceTo: number;
  items: MarkupSuggestion[];
};

export type MarkupAutocompleteTextareaProps = Omit<
  ComponentProps<"textarea">,
  "value" | "onChange"
> & {
  value: string;
  onChange: (value: string, caret?: number) => void;
  "data-testid"?: string;
};

type TagKind = "wrapper" | "value" | "void";

const TAGS: Array<{
  id: string;
  name: string;
  label: string;
  kind: TagKind;
  group: string;
  description: string;
}> = [
  { id: "tag:b", name: "b", label: "Bold", kind: "wrapper", group: "Style", description: "[b]…[/b]" },
  { id: "tag:i", name: "i", label: "Italic", kind: "wrapper", group: "Style", description: "[i]…[/i]" },
  { id: "tag:u", name: "u", label: "Underline", kind: "wrapper", group: "Style", description: "[u]…[/u]" },
  {
    id: "tag:color",
    name: "color",
    label: "Color",
    kind: "value",
    group: "Style",
    description: "[color=green]",
  },
  {
    id: "tag:size",
    name: "size",
    label: "Size",
    kind: "value",
    group: "Style",
    description: "[size=14]",
  },
  {
    id: "tag:outline",
    name: "outline",
    label: "Outline",
    kind: "wrapper",
    group: "Style",
    description: "[outline] or [outline=2]",
  },
  {
    id: "tag:outline-color",
    name: "outline-color",
    label: "Outline Color",
    kind: "value",
    group: "Style",
    description: "[outline-color=…]",
  },
  {
    id: "tag:img",
    name: "img",
    label: "Image",
    kind: "void",
    group: "Image",
    description: "[img=<guid>]",
  },
  {
    id: "tag:shake",
    name: "shake",
    label: "Shake",
    kind: "value",
    group: "Effects",
    description: "[shake=1]",
  },
  {
    id: "tag:wave",
    name: "wave",
    label: "Wave",
    kind: "value",
    group: "Effects",
    description: "[wave=2 intensity=1]",
  },
  {
    id: "tag:hover",
    name: "hover",
    label: "Hover",
    kind: "wrapper",
    group: "Effects",
    description: "[hover] or [hover=1]",
  },
  {
    id: "tag:rotate",
    name: "rotate",
    label: "Rotate",
    kind: "value",
    group: "Effects",
    description: "[rotate=45]",
  },
];

const NAMED_COLORS = [
  "aqua",
  "black",
  "blue",
  "fuchsia",
  "gray",
  "grey",
  "green",
  "lime",
  "maroon",
  "navy",
  "olive",
  "orange",
  "purple",
  "red",
  "silver",
  "teal",
  "white",
  "yellow",
] as const;

function openBracketIndex(value: string, caret: number): number {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "]") return -1;
    if (ch === "[") return i;
  }
  return -1;
}

function tagSuggestions(prefix: string): MarkupSuggestion[] {
  const needle = prefix.toLowerCase();
  return TAGS.filter((tag) => tag.name.startsWith(needle)).map((tag) => ({
    id: tag.id,
    label: tag.label,
    description: tag.description,
    group: tag.group,
  }));
}

function colorSuggestions(prefix: string): MarkupSuggestion[] {
  const needle = prefix.toLowerCase();
  const named: MarkupSuggestion[] = NAMED_COLORS.filter((name) =>
    name.startsWith(needle),
  ).map((name) => ({
    id: `color:${name}`,
    label: name,
    description: `[color=${name}]`,
    group: "Colors",
  }));
  if (needle === "" || needle.startsWith("#")) {
    named.push({
      id: "color-hex",
      label: "#RRGGBB",
      description: "Hex color (hash optional)",
      group: "Colors",
    });
  }
  return named;
}

/** Suggestions for the open `[…]` fragment at `caret`. */
export function markupAutocompleteAt(
  value: string,
  caret: number,
): MarkupAutocompleteSession | null {
  const from = openBracketIndex(value, caret);
  if (from < 0) return null;
  const inner = value.slice(from + 1, caret);
  const parsed = /^([a-zA-Z][a-zA-Z0-9-]*)?(.*)$/.exec(inner);
  if (!parsed) return null;
  const name = (parsed[1] ?? "").toLowerCase();
  const rest = parsed[2] ?? "";

  if (!rest) {
    const items = tagSuggestions(name);
    return items.length > 0 ? { replaceFrom: from, replaceTo: caret, items } : null;
  }

  if (rest.startsWith("=")) {
    const after = rest.slice(1);
    if (!/\s/.test(after)) {
      if (name === "color") {
        const items = colorSuggestions(after);
        return items.length > 0
          ? { replaceFrom: from, replaceTo: caret, items }
          : null;
      }
      if (name === "img") {
        return {
          replaceFrom: from,
          replaceTo: caret,
          items: [
            {
              id: "img-paste",
              label: "Paste Asset Reference",
              description: "Raw Texture guid from Content Browser",
              group: "Image",
            },
          ],
        };
      }
      return null;
    }
  }

  const items: MarkupSuggestion[] = [];
  if (name === "img" && !/\bsize=/i.test(inner) && /\s$/.test(inner)) {
    items.push({
      id: "attr:size",
      label: "size",
      description: "Image height in px",
      group: "Attributes",
    });
  }
  if (name === "wave" && !/\bintensity=/i.test(inner) && /\s$/.test(inner)) {
    items.push({
      id: "attr:intensity",
      label: "intensity",
      description: "Wave amplitude scale",
      group: "Attributes",
    });
  }
  return items.length > 0 ? { replaceFrom: from, replaceTo: caret, items } : null;
}

function insertAt(
  value: string,
  from: number,
  to: number,
  open: string,
  close: string,
  caretInOpen: number,
): { value: string; caret: number } {
  return {
    value: `${value.slice(0, from)}${open}${close}${value.slice(to)}`,
    caret: from + caretInOpen,
  };
}

/** Replace the open fragment with the chosen tag, color, or attribute. */
export function applyMarkupSuggestion(
  value: string,
  session: MarkupAutocompleteSession,
  itemId: string,
): { value: string; caret: number } {
  const { replaceFrom: from, replaceTo: to } = session;
  if (itemId.startsWith("tag:")) {
    const tag = TAGS.find((entry) => entry.id === itemId);
    if (!tag) return { value, caret: to };
    if (tag.kind === "void") {
      const open = `[${tag.name}=]`;
      return insertAt(value, from, to, open, "", open.length - 1);
    }
    if (tag.kind === "value") {
      const open = `[${tag.name}=]`;
      return insertAt(value, from, to, open, `[/${tag.name}]`, open.length - 1);
    }
    const open = `[${tag.name}]`;
    return insertAt(value, from, to, open, `[/${tag.name}]`, open.length);
  }
  if (itemId.startsWith("color:")) {
    const name = itemId.slice("color:".length);
    const open = `[color=${name}]`;
    return insertAt(value, from, to, open, "[/color]", open.length);
  }
  if (itemId === "color-hex") {
    const open = "[color=#]";
    return insertAt(value, from, to, open, "[/color]", open.length - 1);
  }
  if (itemId === "img-paste") {
    return insertAt(value, from, to, "[img=]", "", 5);
  }
  if (itemId === "attr:size" || itemId === "attr:intensity") {
    const attr = itemId === "attr:size" ? "size=" : "intensity=";
    const closer = value.slice(to).startsWith("]") ? "" : "]";
    return {
      value: `${value.slice(0, to)}${attr}${closer}${value.slice(to)}`,
      caret: to + attr.length,
    };
  }
  return { value, caret: to };
}

/** Multi-line markup field that suggests RichText tags at an open `[`. */
export function MarkupAutocompleteTextarea({
  value,
  onChange,
  id,
  disabled,
  className,
  "data-testid": testId,
  ...rest
}: MarkupAutocompleteTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [dismissed, setDismissed] = useState(false);
  const pendingCaret = useRef<number | null>(null);

  const session = useMemo(
    () => (dismissed ? null : markupAutocompleteAt(value, caret)),
    [dismissed, value, caret],
  );
  const open = Boolean(session && session.items.length > 0);

  useEffect(() => {
    const next = pendingCaret.current;
    if (next === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.setSelectionRange(next, next);
  }, [value]);

  const updateCaret = (target: HTMLTextAreaElement) => {
    setCaret(target.selectionStart ?? 0);
    setDismissed(false);
  };

  return (
    <div className="relative">
      <Textarea
        {...rest}
        ref={ref}
        id={id}
        disabled={disabled}
        className={className}
        value={value}
        data-testid={testId}
        onChange={(event) => {
          const next = event.target.value;
          const nextCaret = event.target.selectionStart ?? next.length;
          setCaret(nextCaret);
          setDismissed(false);
          onChange(next, nextCaret);
        }}
        onSelect={(event) => updateCaret(event.currentTarget)}
        onKeyUp={(event) => updateCaret(event.currentTarget)}
        onClick={(event) => updateCaret(event.currentTarget)}
      />
      <SearchDropdown
        open={open}
        onOpenChange={(next) => {
          if (!next) setDismissed(true);
        }}
        title="Markup"
        items={session?.items ?? []}
        onSelect={(itemId) => {
          if (!session) return;
          const applied = applyMarkupSuggestion(value, session, itemId);
          pendingCaret.current = applied.caret;
          setCaret(applied.caret);
          setDismissed(true);
          onChange(applied.value, applied.caret);
        }}
        data-testid={testId ? `${testId}-suggestions` : undefined}
      >
        <button type="button" className="sr-only" tabIndex={-1} aria-hidden>
          Markup
        </button>
      </SearchDropdown>
    </div>
  );
}
