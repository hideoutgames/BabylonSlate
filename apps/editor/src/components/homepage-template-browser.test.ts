import { describe, expect, it } from "vitest";
import { homepageTemplates } from "./homepage-template-browser";

describe("homepageTemplates", () => {
  it("lists the Feature Test starter only in Debug Mode", () => {
    const ids = (debugMode: boolean) => homepageTemplates([{ id: "island", name: "Island" }], { debugMode }).map((template) => template.id);
    expect(ids(false)).toEqual(["blank", "empty", "2d", "template:island"]);
    expect(ids(true)).toEqual(["blank", "empty", "2d", "feature-test", "template:island"]);
  });
});
