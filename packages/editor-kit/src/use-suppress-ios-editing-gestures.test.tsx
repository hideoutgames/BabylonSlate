import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSuppressIosEditingGestures } from "./use-suppress-ios-editing-gestures";
import { SelectableText } from "./selectable-text";

function Host({ enabled = true }: { enabled?: boolean }) {
  useSuppressIosEditingGestures(enabled);
  return (
    <div>
      <div data-testid="chrome">chrome</div>
      <input data-testid="field" />
      <SelectableText>
        <span data-testid="selectable">copy me</span>
      </SelectableText>
    </div>
  );
}

function touchEvent(
  type: "touchstart" | "touchmove",
  target: Element,
  count: number,
): TouchEvent {
  const touches = Array.from({ length: count }, (_, i) => ({
    identifier: i,
    clientX: i * 10,
    clientY: 0,
  })) as unknown as Touch[];
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches,
  });
  Object.defineProperty(event, "target", { value: target });
  target.dispatchEvent(event);
  return event;
}

function historyInput(target: Element, inputType: string): Event {
  const event = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType,
  });
  target.dispatchEvent(event);
  return event;
}

describe("useSuppressIosEditingGestures", () => {
  afterEach(cleanup);

  it("prevents three-finger touchstart and touchmove on chrome", () => {
    const { getByTestId } = render(<Host />);
    const chrome = getByTestId("chrome");
    expect(touchEvent("touchstart", chrome, 3).defaultPrevented).toBe(true);
    expect(touchEvent("touchmove", chrome, 3).defaultPrevented).toBe(true);
  });

  it("does not prevent one-finger touches", () => {
    const { getByTestId } = render(<Host />);
    expect(touchEvent("touchstart", getByTestId("chrome"), 1).defaultPrevented).toBe(
      false,
    );
  });

  it("does not prevent three-finger touches on inputs", () => {
    const { getByTestId } = render(<Host />);
    expect(touchEvent("touchstart", getByTestId("field"), 3).defaultPrevented).toBe(
      false,
    );
  });

  it("does not prevent three-finger touches inside selectable text", () => {
    const { getByTestId } = render(<Host />);
    expect(
      touchEvent("touchstart", getByTestId("selectable"), 3).defaultPrevented,
    ).toBe(false);
  });

  it("prevents historyUndo outside fields and leaves it in inputs", () => {
    const { getByTestId } = render(<Host />);
    expect(historyInput(getByTestId("chrome"), "historyUndo").defaultPrevented).toBe(
      true,
    );
    expect(historyInput(getByTestId("field"), "historyUndo").defaultPrevented).toBe(
      false,
    );
  });

  it("does nothing when disabled", () => {
    const { getByTestId } = render(<Host enabled={false} />);
    expect(touchEvent("touchstart", getByTestId("chrome"), 3).defaultPrevented).toBe(
      false,
    );
  });
});
