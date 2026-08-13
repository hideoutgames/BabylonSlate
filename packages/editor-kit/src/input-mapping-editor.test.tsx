import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { InputMappings } from "@babylonslate/input";
import { InputMappingEditor } from "./input-mapping-editor";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(() => {
  cleanup();
});

const jumpOnly: InputMappings = {
  actions: [
    {
      name: "Jump",
      bindings: [{ device: "key", code: "Space" }],
    },
  ],
  axes: [
    {
      name: "Look",
      kind: "1d",
      bindings: [
        { device: "gamepadAxis", code: "0:2", deadZone: 0.15 },
      ],
    },
  ],
};

describe("InputMappingEditor", () => {
  it("lists action and axis names", () => {
    render(
      <InputMappingEditor value={jumpOnly} onChange={() => {}} />,
    );
    expect(
      (screen.getByTestId("input-action-0-name") as HTMLInputElement).value,
    ).toBe("Jump");
    expect(
      (screen.getByTestId("input-axis-0-name") as HTMLInputElement).value,
    ).toBe("Look");
    expect(screen.getByTestId("input-action-0-binding-0-listen").textContent).toContain(
      "Space",
    );
  });

  it("renames an action", () => {
    const onChange = vi.fn();
    render(<InputMappingEditor value={jumpOnly} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("input-action-0-name"), {
      target: { value: "Leap" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [expect.objectContaining({ name: "Leap" })],
      }),
    );
  });

  it("adds an action mapping", () => {
    const onChange = vi.fn();
    render(<InputMappingEditor value={jumpOnly} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("input-action-add"));
    expect(onChange.mock.calls[0]![0].actions).toHaveLength(2);
    expect(onChange.mock.calls[0]![0].actions[1]).toMatchObject({
      name: "New Action",
      bindings: [],
    });
  });

  it("adds a binding and records a key via listen-to-bind", () => {
    const onChange = vi.fn();
    render(<InputMappingEditor value={jumpOnly} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("input-action-0-add-binding"));
    const withBinding = onChange.mock.calls[0]![0] as InputMappings;
    expect(withBinding.actions[0]!.bindings).toHaveLength(2);
    expect(withBinding.actions[0]!.bindings[1]).toMatchObject({
      device: "key",
      code: "",
    });

    onChange.mockClear();
    render(<InputMappingEditor value={withBinding} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("input-action-0-binding-1-listen"));
    expect(screen.getByTestId("input-action-0-binding-1-listen").textContent).toMatch(
      /press/i,
    );
    fireEvent.keyDown(window, { code: "KeyW", key: "w", shiftKey: true });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            bindings: expect.arrayContaining([
              expect.objectContaining({
                device: "key",
                code: "KeyW",
                modifiers: { shift: true },
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it("reorders bindings with 44px targets", () => {
    const onChange = vi.fn();
    const value: InputMappings = {
      actions: [
        {
          name: "Jump",
          bindings: [
            { device: "key", code: "Space" },
            { device: "key", code: "KeyJ" },
          ],
        },
      ],
      axes: [],
    };
    render(<InputMappingEditor value={value} onChange={onChange} />);
    const up = screen.getByTestId("input-action-0-binding-1-move-up");
    expect(up.className).toMatch(/touch-icon|min-h|size-\[var\(--touch-target/);
    fireEvent.click(up);
    expect(onChange.mock.calls[0]![0].actions[0].bindings.map((b: { code: string }) => b.code)).toEqual(
      ["KeyJ", "Space"],
    );
  });

  it("removes an action", () => {
    const onChange = vi.fn();
    render(<InputMappingEditor value={jumpOnly} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("input-action-0-remove"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ actions: [] }),
    );
  });

  it("toggles axis invert", () => {
    const onChange = vi.fn();
    render(<InputMappingEditor value={jumpOnly} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("input-axis-0-binding-0-invert"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        axes: [
          expect.objectContaining({
            bindings: [expect.objectContaining({ invert: true })],
          }),
        ],
      }),
    );
  });

  it("picks a touch control id from the provided list", () => {
    const onChange = vi.fn();
    const value: InputMappings = {
      actions: [],
      axes: [
        {
          name: "Move",
          kind: "2d",
          bindings: [{ device: "touch", code: "joystick-x", component: "x" }],
        },
      ],
    };
    render(
      <InputMappingEditor
        value={value}
        onChange={onChange}
        touchControlIds={["joystick-x", "custom-stick"]}
      />,
    );
    fireEvent.click(screen.getByTestId("input-axis-0-binding-0-touch-custom-stick"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        axes: [
          expect.objectContaining({
            bindings: [expect.objectContaining({ code: "custom-stick" })],
          }),
        ],
      }),
    );
  });
});
