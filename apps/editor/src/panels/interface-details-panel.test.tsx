import { useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { InterfaceDetailsPanel } from "./interface-details-panel";
import {
  TypeAssetEditingProvider,
  useTypeAssetEditing,
} from "../context/type-asset-editing-context";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const applyAssetDocumentChange = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "script-interface:assets/IHit.babasset",
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "script-interface:assets/IHit.babasset",
        ref: {
          kind: "script-interface",
          path: "assets/IHit.babasset",
          label: "IHit Script Interface",
        },
        content: {
          kind: "scriptInterface",
          guid: "i1",
          name: "IHit",
          methods: [
            {
              name: "OnHit",
              pins: [
                { name: "amount", typeId: "float", direction: "in" },
                {
                  name: "target",
                  typeId: "object",
                  direction: "in",
                  typeClassId: "BObject",
                },
              ],
            },
          ],
        },
        layout: null,
        dirty: false,
      },
    ],
    applyAssetDocumentChange,
    assetRegistry: { list: () => [] },
  }),
}));

function SelectPin({
  memberId,
  pinId,
  children,
}: {
  memberId: string;
  pinId: string;
  children: ReactNode;
}) {
  const { setSelectedMemberId, setSelectedPinId } = useTypeAssetEditing();
  useEffect(() => {
    setSelectedMemberId(memberId);
    setSelectedPinId(pinId);
  }, [memberId, pinId, setSelectedMemberId, setSelectedPinId]);
  return children;
}

afterEach(() => {
  cleanup();
  applyAssetDocumentChange.mockClear();
});

describe("InterfaceDetailsPanel pins", () => {
  it("does not show optional or default on a selected data pin", async () => {
    render(
      <TypeAssetEditingProvider>
        <SelectPin memberId="member:0" pinId="pin:0:0">
          <InterfaceDetailsPanel {...({} as IDockviewPanelProps)} />
        </SelectPin>
      </TypeAssetEditingProvider>,
    );
    expect(await screen.findByTestId("pin-pin:0:0-name")).toBeTruthy();
    expect(screen.queryByTestId("pin-pin:0:0-optional")).toBeNull();
    expect(screen.queryByTestId("pin-pin:0:0-default")).toBeNull();
  });

  it("still shows Class Type on an object pin", async () => {
    render(
      <TypeAssetEditingProvider>
        <SelectPin memberId="member:0" pinId="pin:0:1">
          <InterfaceDetailsPanel {...({} as IDockviewPanelProps)} />
        </SelectPin>
      </TypeAssetEditingProvider>,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("pin-pin:0:1-optional")).toBeNull();
      expect(screen.getByTestId("pin-pin:0:1-class-type")).toBeTruthy();
    });
  });
});
