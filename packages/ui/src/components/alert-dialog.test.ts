import { describe, expect, it } from "vitest";
import { alertDialogContentVariants } from "./alert-dialog";

function classTokens(classes: string): string[] {
  return classes.split(/\s+/).filter(Boolean);
}

describe("alertDialogContentVariants", () => {
  it("uses a red ring and wider max width for destructive confirms", () => {
    const tokens = classTokens(
      alertDialogContentVariants({ variant: "destructive" }),
    );
    expect(tokens).toContain("ring-destructive");
    expect(tokens).toContain("sm:max-w-md");
  });

  it("keeps default confirms on the quiet foreground ring", () => {
    const tokens = classTokens(
      alertDialogContentVariants({ variant: "default" }),
    );
    expect(tokens).toContain("ring-foreground/10");
    expect(tokens).not.toContain("ring-destructive");
    expect(tokens).not.toContain("sm:max-w-md");
  });
});
