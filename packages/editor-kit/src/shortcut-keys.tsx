import { Fragment, type ComponentType, type SVGProps } from "react";
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
import { Kbd, KbdGroup } from "@haptic/ui/components/kbd";
import { cn } from "@haptic/ui/lib/utils";
import {
  chordSteps,
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
 * The steps of a multi-step shortcut are joined by "then".
 */
export function ShortcutKeys({
  chord,
  className,
  apple,
  decorative = false,
}: ShortcutKeysProps) {
  if (!chord) return null;
  const steps = chordSteps(chord).map(parseChord);
  if (!steps.length || steps.some((step) => step === null)) return null;
  const onApple = apple ?? isApplePlatform();
  const label = describeChord(chord, onApple);
  return (
    <KbdGroup
      data-slot="shortcut-keys"
      aria-hidden={decorative || undefined}
      className={cn("shortcut-keys", className)}
    >
      {decorative ? null : <span className="sr-only">{label}</span>}
      {steps.map((step, index) => {
        const keys = [
          ...step!.modifiers.map((modifier) => ({
            id: modifier,
            glyph: modifierGlyph(modifier, onApple),
            text: modifierLabel(modifier, onApple),
          })),
          {
            id: step!.key,
            glyph: KEY_GLYPHS[step!.key] ?? null,
            text: keyLabel(step!.key),
          },
        ];
        return (
          <Fragment key={index}>
            {index > 0 ? <span aria-hidden="true">then</span> : null}
            {keys.map(({ id, glyph: Glyph, text }) => (
              <Kbd key={id} aria-hidden="true">
                {Glyph ? <Glyph /> : text}
              </Kbd>
            ))}
          </Fragment>
        );
      })}
    </KbdGroup>
  );
}
