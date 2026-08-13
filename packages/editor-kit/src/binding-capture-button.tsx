import { useEffect, useState } from "react";
import type { BindingModifiers, InputDevice } from "@babylonslate/input";
import { Button } from "@babylonslate/ui/components/button";
import {
  formatBindingLabel,
  modifiersFromKeyboardEvent,
} from "./format-binding-label";

export interface BindingCaptureButtonProps {
  device: InputDevice;
  code: string;
  modifiers?: BindingModifiers;
  onCapture: (next: {
    code: string;
    modifiers?: BindingModifiers;
  }) => void;
  "data-testid"?: string;
}

function listenPrompt(device: InputDevice): string {
  switch (device) {
    case "mouseButton":
    case "pointer":
      return "Press a Button…";
    case "gamepadButton":
    case "gamepadAxis":
      return "Press a Gamepad…";
    default:
      return "Press a Key…";
  }
}

function idleLabel(
  device: InputDevice,
  code: string,
  modifiers?: BindingModifiers,
): string {
  if (!code) return "Bind";
  return formatBindingLabel(device, code, modifiers);
}

/** Outline button that captures the next key, mouse button, or gamepad input. */
export function BindingCaptureButton({
  device,
  code,
  modifiers,
  onCapture,
  "data-testid": testId,
}: BindingCaptureButtonProps) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;

    const finish = (nextCode: string, nextModifiers?: BindingModifiers) => {
      setListening(false);
      onCapture({ code: nextCode, modifiers: nextModifiers });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      event.preventDefault();
      if (event.code === "Escape") {
        setListening(false);
        return;
      }
      if (device !== "key") return;
      finish(event.code, modifiersFromKeyboardEvent(event));
    };

    const onMouseDown = (event: MouseEvent) => {
      if (device === "mouseButton") {
        event.preventDefault();
        finish(String(event.button));
      } else if (device === "pointer") {
        event.preventDefault();
        finish("primary");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown);

    let interval: ReturnType<typeof setInterval> | undefined;
    if (device === "gamepadButton" || device === "gamepadAxis") {
      interval = setInterval(() => {
        const pads = navigator.getGamepads?.() ?? [];
        for (let padIndex = 0; padIndex < pads.length; padIndex += 1) {
          const pad = pads[padIndex];
          if (!pad) continue;
          if (device === "gamepadButton") {
            const button = pad.buttons.findIndex((entry) => entry.pressed);
            if (button >= 0) {
              finish(`${padIndex}:${button}`);
              return;
            }
          } else {
            const axis = pad.axes.findIndex((value) => Math.abs(value) > 0.6);
            if (axis >= 0) {
              finish(`${padIndex}:${axis}`);
            }
          }
        }
      }, 50);
    }

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
      if (interval) clearInterval(interval);
    };
  }, [device, listening, onCapture]);

  return (
    <Button
      type="button"
      variant="outline"
      size="touch"
      aria-pressed={listening}
      onClick={() => setListening((current) => !current)}
      data-testid={testId}
    >
      {listening ? listenPrompt(device) : idleLabel(device, code, modifiers)}
    </Button>
  );
}
