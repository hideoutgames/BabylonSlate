import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PLUGIN_ICON_OPTIONS, resolvePluginIcon } from "./plugin-icons";

describe("resolvePluginIcon", () => {
  it("draws Discord as Simple Icons' mark in the Discord token, which the icon picker does not offer", () => {
    const Icon = resolvePluginIcon("Discord")!;
    const { container } = render(<Icon className="size-4" color="red" />);
    const svg = container.querySelector("svg")!;
    expect(svg.querySelector("title")?.textContent).toBe("Discord");
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.style.color).toBe("var(--platform-discord)");
    expect(svg.getAttribute("class")).toBe("size-4");
    expect(PLUGIN_ICON_OPTIONS.some((option) => option.key === "Discord")).toBe(false);
  });

  it("resolves a Lucide key with or without its Icon suffix, and nothing for an unknown or empty key", () => {
    const code = PLUGIN_ICON_OPTIONS.find((option) => option.key === "Code")!.icon;
    expect(resolvePluginIcon("Code")).toBe(code);
    expect(resolvePluginIcon(" CodeIcon ")).toBe(code);
    expect(resolvePluginIcon("Nope")).toBeUndefined();
    expect(resolvePluginIcon("")).toBeUndefined();
    expect(resolvePluginIcon(null)).toBeUndefined();
  });
});
