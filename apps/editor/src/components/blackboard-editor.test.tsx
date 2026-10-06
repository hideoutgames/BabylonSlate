import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createDefaultBlackboard } from "@babylonslate/behaviour-tree";
import { BlackboardEditor } from "./blackboard-editor";

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [],
  assetRegistry: { list: () => [{ path: "assets/Item.datadefinition.babasset", header: {
    type: "DataDefinition", guid: "item", name: "Item", payload: { kind: "dataDefinition", fields: [
      { id: "price", name: "Price", typeId: "int", defaultValue: 12 },
    ] },
  } }] },
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

describe("BlackboardEditor", () => {
  it("adds a typed key", () => {
    const onChange = vi.fn();
    render(
      <BlackboardEditor
        payload={createDefaultBlackboard("AI") as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("blackboard-key-alert")).toBeTruthy();
    fireEvent.click(screen.getByTestId("blackboard-add-key"));
    const next = onChange.mock.calls.at(-1)?.[0] as {
      keys: Array<{ name: string }>;
    };
    expect(next.keys.some((key) => key.name === "key")).toBe(true);
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
    fireEvent.click(screen.getByTestId("blackboard-key-type-asset"));
    fireEvent.click(await screen.findByTestId("search-item-item"));
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ keys: [{ name: "Item", type: { kind: "structRef", guid: "item" }, defaultValue: { Price: 12 } }] });
  });
});
