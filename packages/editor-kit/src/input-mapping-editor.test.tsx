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

/** Base UI Select ignores a click that did not start on the item. */
function pickSelectItem(testId: string) {
  const item = screen.getByTestId(testId);
  fireEvent.pointerDown(item);
  fireEvent.click(item);
}

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
    expect(screen.getByTestId("input-action-0-binding-0-code").textContent).toContain(
      "Space",
    );
    expect(screen.queryByTestId("input-action-0-binding-0-listen")).toBeNull();
    expect(screen.queryByText(/press a key/i)).toBeNull();
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

  it("adds a binding and picks a key from the searchable catalog", () => {
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
    fireEvent.click(screen.getByTestId("input-action-0-binding-1-code"));
    expect(screen.getByTestId("input-action-0-binding-1-code-menu")).toBeTruthy();
    screen.getByTestId("search-item-KeyW").click();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            bindings: expect.arrayContaining([
              expect.objectContaining({
                device: "key",
                code: "KeyW",
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it("clears the code when the device changes", () => {
    const onChange = vi.fn();
    render(<InputMappingEditor value={jumpOnly} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("input-action-0-binding-0-device"));
    pickSelectItem("input-action-0-binding-0-device-gamepadButton");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            bindings: [
              expect.objectContaining({ device: "gamepadButton", code: "" }),
            ],
          }),
        ],
      }),
    );
  });

  it("toggles keyboard modifiers on a binding", () => {
    const onChange = vi.fn();
    render(<InputMappingEditor value={jumpOnly} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("input-action-0-binding-0-mod-shift"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            bindings: [expect.objectContaining({ modifiers: { shift: true } })],
          }),
        ],
      }),
    );
  });

  it("hides analog extras on a digital key axis and shows them on a gamepad axis", () => {
    const value: InputMappings = {
      actions: [],
      axes: [
        {
          name: "Move",
          kind: "1d",
          bindings: [
            { device: "key", code: "KeyW", digitalValue: 1 },
            { device: "gamepadAxis", code: "0:0", deadZone: 0.15 },
          ],
        },
      ],
    };
    render(<InputMappingEditor value={value} onChange={() => {}} />);
    expect(screen.getByTestId("input-axis-0-binding-0-digital-value")).toBeTruthy();
    expect(screen.queryByTestId("input-axis-0-binding-0-dead-zone")).toBeNull();
    expect(screen.getByTestId("input-axis-0-binding-1-dead-zone")).toBeTruthy();
    expect(screen.queryByTestId("input-axis-0-binding-1-digital-value")).toBeNull();
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

  it("picks a touch control id from the searchable catalog", () => {
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
    fireEvent.click(screen.getByTestId("input-axis-0-binding-0-code"));
    screen.getByTestId("search-item-custom-stick").click();
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
