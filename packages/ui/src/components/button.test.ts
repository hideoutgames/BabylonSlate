import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

function classTokens(classes: string): string[] {
  return classes.split(/\s+/).filter(Boolean);
}

describe("buttonVariants", () => {
  it("uses a solid filled destructive control for irreversible confirms", () => {
    const tokens = classTokens(buttonVariants({ variant: "destructive" }));
    expect(tokens).toContain("bg-destructive");
    expect(tokens).toContain("text-destructive-foreground");
    expect(tokens).toContain("hover:bg-destructive/90");
    expect(tokens).not.toContain("bg-destructive/10");
  });
});
