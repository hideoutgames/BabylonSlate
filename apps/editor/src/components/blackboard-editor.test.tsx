import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { createDefaultBlackboard } from "@babylonslate/behaviour-tree";
import { BlackboardInspector, BlackboardKeys } from "./blackboard-editor";

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [],
  assetRegistry: { list: () => [{ path: "assets/Item.datadefinition.babasset", header: {
    type: "DataDefinition", guid: "item", name: "Item", payload: { kind: "dataDefinition", fields: [
      { id: "price", name: "Price", typeId: "int", defaultValue: 12 },
    ] },
  } }, { path: "assets/Loadout.structure.babasset", header: {
    type: "Structure", guid: "struct-loadout", name: "Loadout", payload: { fields: [
      { name: "Cue", typeId: "asset", typeClassId: "Audio" },
      { name: "Count", typeId: "int" },
    ] },
  } }, { path: "assets/Jump.audio.babasset", header: { type: "Audio", guid: "audio-1", name: "Jump", payload: {} } }] },
})));

if (typeof window !== "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    writable: true,
    value: PointerEventPolyfill,
  });
}

afterEach(() => {
  cleanup();
});

/** Keys and Inspector side by side, sharing the selection as the docked panels do. */
function BlackboardEditor({ payload, onChange }: { payload: Record<string, unknown>; onChange: (next: Record<string, unknown>, mergeKey?: string) => void }) {
  const [selected, select] = useState<number | null>(0);
  return (
    <>
      <BlackboardKeys payload={payload} onChange={onChange} selected={selected} onSelect={select} />
      <BlackboardInspector payload={payload} onChange={onChange} selected={selected} onSelect={select} />
    </>
  );
}

describe("BlackboardEditor", () => {
  it("adds a typed key", () => {
    const onChange = vi.fn();
    render(
      <BlackboardEditor
        payload={createDefaultBlackboard("AI") as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("tree-row-key:0").textContent).toContain("alert");
    fireEvent.click(screen.getByTestId("blackboard-add-key"));
    const next = onChange.mock.calls.at(-1)?.[0] as {
      keys: Array<{ name: string }>;
    };
    expect(next.keys.some((key) => key.name === "key")).toBe(true);
  });

  it("renames a key on double-tap instead of an always-open name field", async () => {
    const onChange = vi.fn();
    render(
      <BlackboardEditor
        payload={createDefaultBlackboard("AI") as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.queryByRole("textbox", { name: /^Rename/ })).toBeNull();
    const label = within(screen.getByTestId("tree-row-key:0")).getByText("alert");
    for (let tap = 0; tap < 2; tap++) {
      act(() => {
        for (const type of ["pointerdown", "pointerup"]) {
          const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
          Object.defineProperty(event, "pointerId", { value: 1 });
          Object.defineProperty(event, "pointerType", { value: "mouse" });
          label.dispatchEvent(event);
        }
      });
    }
    const input = await screen.findByRole("textbox", { name: "Rename alert" });
    fireEvent.change(input, { target: { value: "threat" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ keys: [{ name: "threat" }] });
  });

  it("deletes the selected key", () => {
    const onChange = vi.fn();
    render(
      <BlackboardEditor
        payload={createDefaultBlackboard("AI") as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("blackboard-delete-key"));
    const next = onChange.mock.calls.at(-1)?.[0] as {
      keys: Array<{ name: string }>;
    };
    expect(next.keys).toEqual([]);
  });

  it("picks an Asset Default guid for an asset key", async () => {
    const onChange = vi.fn();
    render(
      <BlackboardEditor
        payload={{
          name: "AI",
          keys: [
            {
              name: "cue",
              type: { kind: "assetRef", assetType: "Audio" },
              defaultValue: "",
            },
          ],
        }}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("property-default")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-default"));
    expect(
      await screen.findByTestId("blackboard-key-default-asset-picker"),
    ).toBeTruthy();
  });

  it("picks a Structure Default's asset field without replacing the other fields", async () => {
    const onChange = vi.fn();
    render(
      <BlackboardEditor
        payload={{
          name: "AI",
          keys: [{ name: "loadout", type: { kind: "structRef", guid: "struct-loadout" }, defaultValue: { Cue: "", Count: 3 } }],
        }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("property-:Cue"));
    fireEvent.click(await screen.findByTestId("search-item-audio-1"));
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({
      keys: [{ name: "loadout", defaultValue: { Cue: "audio-1", Count: 3 } }],
    });
  });

  it("edits a bool default as a checkbox", () => {
    const onChange = vi.fn();
    render(
      <BlackboardEditor
        payload={createDefaultBlackboard("AI") as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("property-default"));
    const next = onChange.mock.calls.at(-1)?.[0] as {
      keys: Array<{ defaultValue?: unknown }>;
    };
    expect(next.keys[0]?.defaultValue).toBe(true);
    expect(
      screen.getByTestId("blackboard-key-type").compareDocumentPosition(
        screen.getByTestId("property-default"),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
  });

  it("writes enumRef when the type picker selects Enum", async () => {
    const onChange = vi.fn();
    render(
      <BlackboardEditor
        payload={createDefaultBlackboard("AI") as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("blackboard-key-type"));
    const enumItem = await screen.findByTestId("search-item-enum");
    fireEvent.click(enumItem);
    const next = onChange.mock.calls.at(-1)?.[0] as {
      keys: Array<{ type: { kind: string } }>;
    };
    expect(next.keys[0]?.type).toEqual({ kind: "enumRef", guid: "" });
  });

  it("selects a Data Definition as a record key and initializes its defaults", async () => {
    const onChange = vi.fn();
    render(<BlackboardEditor payload={{ name: "AI", keys: [{ name: "Item", type: { kind: "structRef", guid: "" } }] }} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("property-type-asset"));
    fireEvent.click(await screen.findByTestId("search-item-item"));
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ keys: [{ name: "Item", type: { kind: "structRef", guid: "item" }, defaultValue: { Price: 12 } }] });
  });
});
