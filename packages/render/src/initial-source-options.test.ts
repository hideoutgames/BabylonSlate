import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_PROJECT_SETTINGS } from "@haptic/core";
import type { CreateEngineOptions } from "./create-engine-types";
import { releaseInitialSourceOptions } from "./initial-source-options";

describe("initial source options", () => {
  it("drops every initial source a view's options copy holds, the exported player's installed Model sources included", () => {
    const model = new Blob([new Uint8Array([1, 2])], { type: "model/gltf-binary" });
    const options: CreateEngineOptions = {
      playMode: true,
      frameCap: 30,
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      textureBytes: new Map([["wall", new Blob([new Uint8Array([3])])]]),
      modelBytes: new Map([["crate", new Uint8Array([1, 2])]]),
      modelSources: new Map([["crate", model]]),
      fontMsdfPng: new Map([["ui", new Blob([new Uint8Array([4])])]]),
      fontFaceEntries: [{ guid: "ui", family: "UI", bytes: new ArrayBuffer(1) }],
      materialDocuments: new Map(),
      navmeshBytes: new Uint8Array([5]),
    };
    releaseInitialSourceOptions(options);
    // Released sources stay alive only through the views that still use them; the view's settings outlive the lease.
    expect(options).toEqual({ playMode: true, frameCap: 30, renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS });
  });
});
