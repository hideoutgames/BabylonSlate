import { describe, expect, it } from "vitest";
import { exportGameFailureMessage } from "./export-game-failure";

describe("exportGameFailureMessage", () => {
  it("maps fflate DOS date failures to human copy", () => {
    expect(
      exportGameFailureMessage(new Error("date not in range 1980-2099")),
    ).toBe("Could not build the zip. Try again.");
  });

  it("maps generic zip failures to human copy", () => {
    expect(exportGameFailureMessage(new Error("zip failed"))).toBe(
      "Could not build the zip. Try again.",
    );
  });

  it("keeps other export errors readable", () => {
    expect(exportGameFailureMessage(new Error("Startup scene missing"))).toBe(
      "Startup scene missing",
    );
  });
});
