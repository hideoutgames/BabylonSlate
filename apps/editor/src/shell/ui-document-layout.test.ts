import { describe, expect, it } from "vitest";
import {
  applyPreFocusToUiLayout,
  normalizeUiEditorMode,
  parseUiDocumentLayout,
  serializeUiDocumentLayout,
} from "./ui-document-layout";

describe("normalizeUiEditorMode", () => {
  it("defaults to Designer", () => {
    expect(normalizeUiEditorMode(undefined)).toBe("designer");
    expect(normalizeUiEditorMode("designer")).toBe("designer");
    expect(normalizeUiEditorMode("logic")).toBe("logic");
    expect(normalizeUiEditorMode("graph")).toBe("designer");
  });
});

describe("parseUiDocumentLayout", () => {
  it("treats a legacy DockView snapshot as the Designer layout", () => {
    const legacy = { grid: { root: {} }, panels: { "ui-design": {} } };
    expect(parseUiDocumentLayout(legacy)).toEqual({
      uiEditorMode: "designer",
      designer: legacy,
      logic: null,
    });
  });

  it("reads split Designer and Logic snapshots", () => {
    const stored = {
      uiEditorMode: "logic",
      designer: { grid: { id: "design" } },
      logic: { grid: { id: "logic" } },
    };
    expect(parseUiDocumentLayout(stored)).toEqual({
      uiEditorMode: "logic",
      designer: { grid: { id: "design" } },
      logic: { grid: { id: "logic" } },
    });
  });

  it("returns empty Designer/Logic when layout is missing", () => {
    expect(parseUiDocumentLayout(null)).toEqual({
      uiEditorMode: "designer",
      designer: null,
      logic: null,
    });
  });
});

describe("serializeUiDocumentLayout", () => {
  it("writes mode plus both DockView snapshots", () => {
    expect(
      serializeUiDocumentLayout({
        uiEditorMode: "logic",
        designer: { grid: { id: "d" } },
        logic: { grid: { id: "l" } },
      }),
    ).toEqual({
      uiEditorMode: "logic",
      designer: { grid: { id: "d" } },
      logic: { grid: { id: "l" } },
    });
  });
});

describe("applyPreFocusToUiLayout", () => {
  const current = {
    uiEditorMode: "designer" as const,
    designer: { focused: true },
    logic: { graph: true },
  };

  it("writes the snapshot into the Designer slot without touching Logic", () => {
    expect(
      applyPreFocusToUiLayout(current, {
        layout: { restored: true },
        surface: "designer",
      }),
    ).toEqual({
      uiEditorMode: "designer",
      designer: { restored: true },
      logic: { graph: true },
    });
  });

  it("writes the snapshot into the Logic slot without touching Designer", () => {
    expect(
      applyPreFocusToUiLayout(
        { ...current, uiEditorMode: "logic" },
        { layout: { restored: true }, surface: "logic" },
      ),
    ).toEqual({
      uiEditorMode: "logic",
      designer: { focused: true },
      logic: { restored: true },
    });
  });

  it("leaves both surfaces alone for the default DockView surface", () => {
    expect(
      applyPreFocusToUiLayout(current, {
        layout: { restored: true },
        surface: "default",
      }),
    ).toEqual(current);
  });
});
