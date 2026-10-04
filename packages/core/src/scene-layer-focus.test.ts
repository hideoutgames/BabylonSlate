import { describe, expect, it } from "vitest";
import { normalizeProjectSettings } from "./project";
import { normalizeFocusNavigationSettings, parseFocusTargetProperties } from "./scene-layer-focus";

describe("focus authoring data", () => {
  it("keeps authored targets and safe repeat limits while legacy projects gain working controls", () => {
    expect(normalizeProjectSettings(undefined).focusNavigation).toMatchObject({ enabled: true, navigationInputGuid: null, activateInputGuid: null });
    expect(normalizeFocusNavigationSettings({ enabled: false, navigationInputGuid: " axis ", activateInputGuid: 7, repeatDelay: Infinity, repeatInterval: -1, wrap: true })).toEqual({
      enabled: false, navigationInputGuid: "axis", activateInputGuid: null, repeatDelay: 0.4, repeatInterval: 0.02, wrap: true,
    });
    expect(parseFocusTargetProperties({ focusEnabled: false, focusInitial: true, focusRight: " other ", focusLeft: {}, focused: true })).toEqual({
      focusEnabled: false, focusInitial: true, focusRight: "other", focusLeft: null, focusUp: null, focusDown: null,
    });
  });
});
