import { describe, expect, it } from "vitest";
import { parseOutputLogLine } from "./output-log-line";

describe("parseOutputLogLine", () => {
  it("splits a leading source tag from the message", () => {
    expect(parseOutputLogLine("[Extension acme.tools] Activated")).toEqual({
      severity: "info",
      source: "Extension acme.tools",
      message: "Activated",
    });
  });

  it("keeps untagged lines whole", () => {
    expect(parseOutputLogLine("Loaded [3] actors")).toMatchObject({
      source: null,
      message: "Loaded [3] actors",
    });
  });

  it("marks failures as errors", () => {
    expect(parseOutputLogLine("Play failed: could not create Engine.").severity).toBe("error");
    expect(parseOutputLogLine("[Engine] Shader compile error in Water").severity).toBe("error");
  });

  it("prefers an explicit warning over failure wording in its details", () => {
    expect(
      parseOutputLogLine("Preview Build warning: texture failed to encode, using PNG").severity,
    ).toBe("warning");
  });

  it("does not treat words that merely contain a keyword as problems", () => {
    expect(parseOutputLogLine("[Engine] Terrorform spawned; defaults kept").severity).toBe("info");
  });
});
