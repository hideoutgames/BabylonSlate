import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  normalizeInputMappings,
  type InputMappings,
} from "@babylonslate/input";
import { InputMappingEditor } from "./input-mapping-editor";

if (
  typeof window !== "undefined" &&
  typeof window.PointerEvent === "undefined"
) {
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
      bindings: [{ device: "gamepadAxis", code: "0:2", deadZone: 0.15 }],
    },
  ],
};

describe("InputMappingEditor", () => {
  it("shows searchable mapping summaries and edits only the selected mapping", () => {
    render(<InputMappingEditor value={jumpOnly} onChange={() => {}} />);
    expect(screen.getByTestId("input-action-0-name")).toBeTruthy();
    expect(screen.queryByTestId("input-axis-0-name")).toBeNull();
    expect(screen.getByTestId("input-action-0-select").textContent).toContain(
      "Space",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search Mappings" }), {
      target: { value: "Look" },
    });
    expect(screen.queryByTestId("input-action-0-select")).toBeNull();
    fireEvent.click(screen.getByTestId("input-axis-0-select"));
    expect(screen.getByTestId("input-axis-0-name")).toHaveProperty(
      "value",
      "Look",
    );
    expect(screen.queryByTestId("input-action-0-name")).toBeNull();
  });

  it("keeps name drafts focused and rejects empty or duplicate names before saving", () => {
    const onChange = vi.fn();
    const value = {
      ...jumpOnly,
      actions: [...jumpOnly.actions, { name: "Fire", bindings: [] }],
    };
    const { rerender } = render(
      <InputMappingEditor value={value} onChange={onChange} />,
    );
    const name = screen.getByTestId("input-action-0-name");
    name.focus();
    fireEvent.change(name, { target: { value: "Fire" } });
    expect(document.activeElement).toBe(name);
    fireEvent.blur(name);
    expect(onChange).not.toHaveBeenCalled();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(name, { target: { value: " " } });
    fireEvent.blur(name);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Leap" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onChange.mock.calls[0]![0].actions[0].name).toBe("Leap");
    rerender(
      <InputMappingEditor
        value={onChange.mock.calls[0]![0]}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("input-action-0-name")).toBe(name);
  });

  it("creates distinct mapping names and selects the new mapping", () => {
    const onChange = vi.fn();
    const value = {
      ...jumpOnly,
      actions: [...jumpOnly.actions, { name: "New Action", bindings: [] }],
    };
    const { rerender } = render(
      <InputMappingEditor value={value} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId("input-action-add"));
    const next = onChange.mock.calls[0]![0];
    expect(next.actions[2].name).toBe("New Action 2");
    rerender(<InputMappingEditor value={next} onChange={onChange} />);
    expect(screen.getByTestId("input-action-2-name")).toHaveProperty(
      "value",
      "New Action 2",
    );
  });

  it("renames an action", () => {
    const onChange = vi.fn();
    render(<InputMappingEditor value={jumpOnly} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("input-action-0-name"), {
      target: { value: "Leap" },
    });
    fireEvent.blur(screen.getByTestId("input-action-0-name"));
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
    expect(
      screen.getByTestId("input-action-0-binding-1-code-menu"),
    ).toBeTruthy();
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

  it("keeps a draft row when switching back to Key through authoring normalize", () => {
    let saved: InputMappings = jumpOnly;
    const onChange = (next: InputMappings) => {
      saved = next;
    };
    const view = () => (
      <InputMappingEditor
        value={normalizeInputMappings(saved, { allowIncomplete: true })}
        onChange={onChange}
      />
    );
    const { rerender } = render(view());
    fireEvent.click(screen.getByTestId("input-action-0-binding-0-device"));
    pickSelectItem("input-action-0-binding-0-device-gamepadButton");
    rerender(view());
    expect(screen.getByTestId("input-action-0-binding-0-code")).toBeTruthy();

    fireEvent.click(screen.getByTestId("input-action-0-binding-0-device"));
    pickSelectItem("input-action-0-binding-0-device-key");
    rerender(view());
    expect(
      screen.getByTestId("input-action-0-binding-0-code").textContent,
    ).toContain("Choose Key");

    fireEvent.click(screen.getByTestId("input-action-0-add-binding"));
    rerender(view());
    expect(screen.getByTestId("input-action-0-binding-1-code")).toBeTruthy();
  });

  it("lists layout-agnostic Gamepad Button and Gamepad Axis devices", () => {
    render(<InputMappingEditor value={jumpOnly} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId("input-action-0-binding-0-device"));
    expect(
      screen.getByTestId("input-action-0-binding-0-device-gamepadButton")
        .textContent,
    ).toBe("Gamepad Button");
    expect(
      screen.getByTestId("input-action-0-binding-0-device-gamepadAxis")
        .textContent,
    ).toBe("Gamepad Axis");
    expect(
      screen.queryByTestId("input-action-0-binding-0-device-pointer"),
    ).toBeNull();
    expect(
      screen.queryByTestId("input-action-0-binding-0-device-touch"),
    ).toBeNull();
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
    expect(
      screen.queryByTestId("input-action-0-binding-0-mod-shift"),
    ).toBeNull();
    fireEvent.click(screen.getByTestId("input-action-0-binding-0-options"));
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
    fireEvent.click(screen.getByTestId("input-axis-0-binding-0-options"));
    fireEvent.click(screen.getByTestId("input-axis-0-binding-1-options"));
    expect(
      screen.getByTestId("input-axis-0-binding-0-digital-value"),
    ).toBeTruthy();
    expect(screen.queryByTestId("input-axis-0-binding-0-dead-zone")).toBeNull();
    expect(screen.getByTestId("input-axis-0-binding-1-dead-zone")).toBeTruthy();
    expect(
      screen.queryByTestId("input-axis-0-binding-1-digital-value"),
    ).toBeNull();
  });

  it("reorders bindings without changing their codes", () => {
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
    fireEvent.click(up);
    expect(
      onChange.mock.calls[0]![0].actions[0].bindings.map(
        (b: { code: string }) => b.code,
      ),
    ).toEqual(["KeyJ", "Space"]);
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
    fireEvent.click(screen.getByTestId("input-axis-0-select"));
    fireEvent.click(screen.getByTestId("input-axis-0-binding-0-options"));
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

  it("picks an analog gamepad control from the searchable catalog", () => {
    const onChange = vi.fn();
    const value: InputMappings = {
      actions: [],
      axes: [
        {
          name: "Move",
          kind: "2d",
          bindings: [{ device: "gamepadAxis", code: "0:0", component: "x" }],
        },
      ],
    };
    render(<InputMappingEditor value={value} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("input-axis-0-binding-0-code"));
    screen.getByTestId("search-item-0:2").click();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        axes: [
          expect.objectContaining({
            bindings: [
              expect.objectContaining({ code: "0:2", component: "x" }),
            ],
          }),
        ],
      }),
    );
  });
});
