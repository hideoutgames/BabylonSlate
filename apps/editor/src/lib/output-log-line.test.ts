import { describe, expect, it } from "vitest";
import { formatRuntimeLogLine, parseOutputLogLine } from "./output-log-line";

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

describe("formatRuntimeLogLine", () => {
  it.each([
    [{ category: "Script", severity: "log", message: "Hello" }, "[Script] Hello", { severity: "info", source: "Script", message: "Hello" }],
    [{ category: "Fuel", severity: "warning", message: "Low" }, "[Fuel] Warning: Low", { severity: "warning", source: "Fuel", message: "Warning: Low" }],
    [{ category: "Fuel", severity: "error", message: "Empty" }, "[Fuel] Error: Empty", { severity: "error", source: "Fuel", message: "Error: Empty" }],
    [{ category: "Fuel", severity: "verbose", message: "Tick" }, "[Fuel] Verbose: Tick", { severity: "info", source: "Fuel", message: "Verbose: Tick" }],
    [{ category: "", severity: "log", message: "Sound started" }, "Sound started", { severity: "info", source: null, message: "Sound started" }],
  ])("writes %j so the panel shows its category and severity", (entry, line, parsed) => {
    expect(formatRuntimeLogLine(entry)).toBe(line);
    expect(parseOutputLogLine(line)).toEqual(parsed);
  });
});
