import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { EditorUtilityRuntime } from "./editor-utility-runtime";
import {
  EDITOR_UTILITY_EVENTS,
  EDITOR_UTILITY_LIFECYCLE_EVENT,
} from "../lib/editor-utility-scripts";

const { invokeEvent, load, docs } = vi.hoisted(() => ({
  invokeEvent: vi.fn(),
  load: vi.fn(async () => {}),
  docs: {
    projectName: "Demo" as string | null,
    projectDocument: {
      settings: { editorUtilityObjects: ["Tools"] },
    } as { settings: { editorUtilityObjects: string[] } } | null,
    openDocuments: [] as Array<{ ref: { kind: string } }>,
    collectEditorUtilityScripts: vi.fn(async () => [{ classId: "Tools" }]),
    pluginDescriptors: [] as Array<{
      pluginGuid: string;
      settings: { editorUtilityObjects: string[]; enabledByDefault: boolean };
    }>,
  },
}));

vi.mock("@babylonslate/runtime", () => ({
  ScriptHost: class {
    load = load;
    invokeEvent = invokeEvent;
    classIds = () => ["Tools"];
  },
}));

vi.mock("../context/play-context", () => ({
  usePlay: () => ({ appendLog: vi.fn() }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => docs,
}));

afterEach(() => {
  cleanup();
  invokeEvent.mockReset();
  load.mockClear();
  docs.projectName = "Demo";
  docs.projectDocument = {
    settings: { editorUtilityObjects: ["Tools"] },
  };
  docs.openDocuments = [];
  docs.collectEditorUtilityScripts.mockClear();
  docs.pluginDescriptors = [];
});

describe("EditorUtilityRuntime", () => {
  it("boots On Editor Startup then On Scene Open when a scene tab is already open", async () => {
    docs.openDocuments = [{ ref: { kind: "scene" } }];
    render(<EditorUtilityRuntime />);
    await waitFor(() => {
      expect(invokeEvent.mock.calls.map((call) => call[1])).toEqual([
        EDITOR_UTILITY_EVENTS.startup,
        EDITOR_UTILITY_EVENTS.sceneOpen,
      ]);
    });
  });

  it("fires On Editor Shutdown when the host unmounts after start", async () => {
    const view = render(<EditorUtilityRuntime />);
    await waitFor(() => {
      expect(invokeEvent).toHaveBeenCalledWith(
        "Tools",
        EDITOR_UTILITY_EVENTS.startup,
      );
    });
    invokeEvent.mockClear();
    view.unmount();
    expect(invokeEvent).toHaveBeenCalledWith(
      "Tools",
      EDITOR_UTILITY_EVENTS.shutdown,
    );
  });

  it("does not reboot when project settings identity changes with the same list", async () => {
    const view = render(<EditorUtilityRuntime />);
    await waitFor(() => {
      expect(invokeEvent).toHaveBeenCalledWith(
        "Tools",
        EDITOR_UTILITY_EVENTS.startup,
      );
    });
    const loads = docs.collectEditorUtilityScripts.mock.calls.length;
    invokeEvent.mockClear();
    docs.projectDocument = {
      settings: { editorUtilityObjects: ["Tools"] },
    };
    view.rerender(<EditorUtilityRuntime />);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(docs.collectEditorUtilityScripts).toHaveBeenCalledTimes(loads);
    expect(invokeEvent).not.toHaveBeenCalled();
  });

  it("re-fires startup after the Project Settings list changes", async () => {
    const view = render(<EditorUtilityRuntime />);
    await waitFor(() => {
      expect(invokeEvent).toHaveBeenCalledWith(
        "Tools",
        EDITOR_UTILITY_EVENTS.startup,
      );
    });
    invokeEvent.mockClear();
    docs.projectDocument = {
      settings: { editorUtilityObjects: ["Tools", "More"] },
    };
    view.rerender(<EditorUtilityRuntime />);
    await waitFor(() => {
      expect(invokeEvent.mock.calls.map((call) => call[1])).toEqual([
        EDITOR_UTILITY_EVENTS.shutdown,
        EDITOR_UTILITY_EVENTS.startup,
      ]);
    });
  });

  it("does not fire On Editor Shutdown twice when project close already did", async () => {
    const view = render(<EditorUtilityRuntime />);
    await waitFor(() => {
      expect(invokeEvent).toHaveBeenCalledWith(
        "Tools",
        EDITOR_UTILITY_EVENTS.startup,
      );
    });
    window.dispatchEvent(
      new CustomEvent(EDITOR_UTILITY_LIFECYCLE_EVENT, {
        detail: { event: EDITOR_UTILITY_EVENTS.shutdown },
      }),
    );
    expect(invokeEvent).toHaveBeenCalledWith(
      "Tools",
      EDITOR_UTILITY_EVENTS.shutdown,
    );
    invokeEvent.mockClear();
    view.unmount();
    expect(invokeEvent).not.toHaveBeenCalled();
  });

  it("does not reboot for a disabled plugin's editor utility objects", async () => {
    const view = render(<EditorUtilityRuntime />);
    await waitFor(() => {
      expect(invokeEvent).toHaveBeenCalledWith(
        "Tools",
        EDITOR_UTILITY_EVENTS.startup,
      );
    });
    const loads = docs.collectEditorUtilityScripts.mock.calls.length;
    invokeEvent.mockClear();
    docs.pluginDescriptors = [
      {
        pluginGuid: "off",
        settings: {
          editorUtilityObjects: ["PackTools"],
          enabledByDefault: false,
        },
      },
    ];
    view.rerender(<EditorUtilityRuntime />);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(docs.collectEditorUtilityScripts).toHaveBeenCalledTimes(loads);
    expect(invokeEvent).not.toHaveBeenCalled();
  });
});
