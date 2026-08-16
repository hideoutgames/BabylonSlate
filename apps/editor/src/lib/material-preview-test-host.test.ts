import { afterEach, describe, expect, it } from "vitest";
import {
  materialPreviewCameraRadius,
  registerMaterialPreviewCameraRadius,
} from "./material-preview-test-host";

afterEach(() => {
  registerMaterialPreviewCameraRadius(null);
});

describe("materialPreviewCameraRadius", () => {
  it("is null when no preview host is registered", () => {
    expect(materialPreviewCameraRadius()).toBeNull();
  });

  it("reads the live preview camera radius from the registered host", () => {
    registerMaterialPreviewCameraRadius(() => 4.25);
    expect(materialPreviewCameraRadius()).toBe(4.25);
  });

  it("clears the reader on unregister so a closed tab cannot leak", () => {
    registerMaterialPreviewCameraRadius(() => 8);
    registerMaterialPreviewCameraRadius(null);
    expect(materialPreviewCameraRadius()).toBeNull();
  });
});
