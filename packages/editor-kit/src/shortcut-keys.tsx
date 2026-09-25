import type { ComponentType, SVGProps } from "react";
import {
  ArrowBigUpIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ChevronUpIcon,
  CommandIcon,
  CornerDownLeftIcon,
  DeleteIcon,
  OptionIcon,
} from "lucide-react";
import { Kbd, KbdGroup } from "@babylonslate/ui/components/kbd";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  describeChord,
  isApplePlatform,
  keyLabel,
  modifierLabel,
  parseChord,
  type ChordModifier,
  type KeyChord,
} from "./keybinds";

type Glyph = ComponentType<SVGProps<SVGSVGElement>>;

const KEY_GLYPHS: Record<string, Glyph> = {
  ArrowUp: ArrowUpIcon,
  ArrowDown: ArrowDownIcon,
  ArrowLeft: ArrowLeftIcon,
  ArrowRight: ArrowRightIcon,
  Enter: CornerDownLeftIcon,
  Backspace: DeleteIcon,
};

function modifierGlyph(modifier: ChordModifier, apple: boolean): Glyph | null {
  if (modifier === "Shift") return ArrowBigUpIcon;
  if (!apple) return null;
  if (modifier === "Mod") return CommandIcon;
  if (modifier === "Alt") return OptionIcon;
  return ChevronUpIcon;
}

export interface ShortcutKeysProps {
  chord: KeyChord | null | undefined;
  className?: string;
  /** Platform override for previews and tests. */
  apple?: boolean;
  /**
   * Hide from assistive technology when the owner already exposes the chord
   * through `aria-keyshortcuts` (menu items).
   */
  decorative?: boolean;
}

/**
 * Keyboard chord as compact keycaps. Modifiers use platform glyphs where they
 * exist (Command, Option, Shift); screen readers get the spelled-out chord.
 */
export function ShortcutKeys({
  chord,
  className,
  apple,
  decorative = false,
}: ShortcutKeysProps) {
  if (!chord) return null;
  const parsed = parseChord(chord);
  if (!parsed) return null;
  const onApple = apple ?? isApplePlatform();
  const label = describeChord(chord, onApple);
  const keys = [
    ...parsed.modifiers.map((modifier) => ({
      id: modifier,
      glyph: modifierGlyph(modifier, onApple),
      text: modifierLabel(modifier, onApple),
    })),
    {
      id: parsed.key,
      glyph: KEY_GLYPHS[parsed.key] ?? null,
      text: keyLabel(parsed.key),
    },
  ];
  return (
    <KbdGroup
      data-slot="shortcut-keys"
      aria-hidden={decorative || undefined}
      className={cn("shortcut-keys", className)}
    >
      {decorative ? null : <span className="sr-only">{label}</span>}
      {keys.map(({ id, glyph: Glyph, text }) => (
        <Kbd key={id} aria-hidden="true">
          {Glyph ? <Glyph /> : text}
        </Kbd>
      ))}
    </KbdGroup>
  );
}
