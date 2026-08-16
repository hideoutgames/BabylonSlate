import { describe, expect, it } from "vitest";
import {
  applyPreFocusToAnimLayout,
  normalizeAnimEditorMode,
  parseAnimDocumentLayout,
  serializeAnimDocumentLayout,
} from "./anim-document-layout";

describe("normalizeAnimEditorMode", () => {
  it("defaults unknown values to State Machine", () => {
    expect(normalizeAnimEditorMode(undefined)).toBe("stateMachine");
    expect(normalizeAnimEditorMode("stateMachine")).toBe("stateMachine");
    expect(normalizeAnimEditorMode("animationObject")).toBe("animationObject");
    expect(normalizeAnimEditorMode("graph")).toBe("stateMachine");
  });
});

describe("parseAnimDocumentLayout", () => {
  it("migrates a raw DockView snapshot onto the State Machine surface", () => {
    const raw = { grid: { root: {} } };
    expect(parseAnimDocumentLayout(raw)).toEqual({
      animEditorMode: "stateMachine",
      stateMachine: raw,
      animationObject: null,
    });
  });

  it("reads a split State Machine / Animation Object layout", () => {
    expect(
      parseAnimDocumentLayout({
        animEditorMode: "animationObject",
        stateMachine: { grid: { id: "sm" } },
        animationObject: { grid: { id: "ao" } },
      }),
    ).toEqual({
      animEditorMode: "animationObject",
      stateMachine: { grid: { id: "sm" } },
      animationObject: { grid: { id: "ao" } },
    });
  });
});

describe("serializeAnimDocumentLayout", () => {
  it("round-trips the split layout", () => {
    const layout = {
      animEditorMode: "animationObject" as const,
      stateMachine: { grid: { id: "sm" } },
      animationObject: { grid: { id: "ao" } },
    };
    expect(parseAnimDocumentLayout(serializeAnimDocumentLayout(layout))).toEqual(
      layout,
    );
  });
});

describe("applyPreFocusToAnimLayout", () => {
  it("writes a pre-Focus snapshot into the matching surface", () => {
    const current = {
      animEditorMode: "stateMachine" as const,
      stateMachine: { grid: { id: "sm" } },
      animationObject: { grid: { id: "ao" } },
    };
    expect(
      applyPreFocusToAnimLayout(current, {
        layout: { grid: { id: "focused" } },
        surface: "animationObject",
      }),
    ).toEqual({
      ...current,
      animationObject: { grid: { id: "focused" } },
    });
  });
});
