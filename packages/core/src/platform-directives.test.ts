import { describe, expect, it } from "vitest";
import {
  applyPlatformDirectives,
  evaluatePlatformCondition,
  platformModuleCondition,
  platformSymbols,
} from "./platform-directives";

const desktopPlay = platformSymbols("windows", { editor: true });
const webGame = platformSymbols("web", { editor: false });

describe("platformSymbols", () => {
  it.each([
    ["web", false, ["WITH_WEB"]],
    ["windows", false, ["WITH_DESKTOP", "WITH_WINDOWS"]],
    ["macos", false, ["WITH_DESKTOP", "WITH_MACOS"]],
    ["linux", true, ["WITH_DESKTOP", "WITH_LINUX", "WITH_EDITOR"]],
    ["android", false, ["WITH_MOBILE", "WITH_ANDROID"]],
    ["ios", true, ["WITH_MOBILE", "WITH_IOS", "WITH_EDITOR"]],
  ] as const)("gives %s (editor %s) exactly its family", (platform, editor, expected) => {
    expect([...platformSymbols(platform, { editor })].sort()).toEqual([...expected].sort());
  });
});

describe("evaluatePlatformCondition", () => {
  it.each([
    ["WITH_DESKTOP", true],
    ["!WITH_DESKTOP", false],
    ["WITH_DESKTOP && WITH_MOBILE", false],
    ["WITH_DESKTOP || WITH_MOBILE", true],
    ["WITH_MOBILE || WITH_WEB && WITH_EDITOR", false],
    ["(WITH_MOBILE || WITH_WINDOWS) && WITH_EDITOR", true],
    ["!(WITH_LINUX || WITH_MACOS)", true],
    ["!!WITH_WINDOWS", true],
  ])("%s on Windows Play is %s", (expression, expected) => {
    expect(evaluatePlatformCondition(expression, desktopPlay)).toBe(expected);
  });

  it.each([
    ["WITH_DESKTOP && WITH_TV", "Unknown platform symbol WITH_TV"],
    ["", "A platform condition is missing."],
    ["WITH_DESKTOP &&", "A platform symbol is missing"],
    ["(WITH_DESKTOP", "A \")\" is missing"],
    ["WITH_DESKTOP WITH_MOBILE", "Unexpected text after"],
    ["WITH_DESKTOP & WITH_MOBILE", "Unexpected \"& WITH_MOBILE\""],
  ])("rejects %j", (expression, message) => {
    expect(() => evaluatePlatformCondition(expression, desktopPlay)).toThrow(message);
  });

  it("reports an unknown symbol on the side a short circuit would skip", () => {
    expect(() => evaluatePlatformCondition("WITH_DESKTOP || WITH_CONSOLE", desktopPlay)).toThrow("WITH_CONSOLE");
  });
});

describe("applyPlatformDirectives", () => {
  const source = [
    "a();",
    "// #if WITH_DESKTOP",
    "desktop();",
    "  // #elif WITH_MOBILE",
    "mobile();",
    "// #else",
    "other();",
    "// #endif",
    "z();",
  ].join("\n");

  it("keeps only the first true branch and blanks the others, keeping every line", () => {
    expect(applyPlatformDirectives(source, desktopPlay).split("\n")).toEqual([
      "a();", "// #if WITH_DESKTOP", "desktop();", "  // #elif WITH_MOBILE", "", "// #else", "", "// #endif", "z();",
    ]);
    expect(applyPlatformDirectives(source, platformSymbols("android", { editor: false })).split("\n")).toEqual([
      "a();", "// #if WITH_DESKTOP", "", "  // #elif WITH_MOBILE", "mobile();", "// #else", "", "// #endif", "z();",
    ]);
    expect(applyPlatformDirectives(source, webGame).split("\n")).toEqual([
      "a();", "// #if WITH_DESKTOP", "", "  // #elif WITH_MOBILE", "", "// #else", "other();", "// #endif", "z();",
    ]);
  });

  it("keeps a nested region inactive inside an inactive one, whatever its own condition", () => {
    const nested = ["// #if WITH_MOBILE", "// #if WITH_WINDOWS", "x();", "// #else", "y();", "// #endif", "// #endif"].join("\n");
    expect(applyPlatformDirectives(nested, desktopPlay).split("\n")).toEqual([
      "// #if WITH_MOBILE", "// #if WITH_WINDOWS", "", "// #else", "", "// #endif", "// #endif",
    ]);
  });

  it("keeps CRLF line endings on blanked lines and ignores #region comments", () => {
    expect(applyPlatformDirectives("// #region Setup\r\n// #if WITH_IOS\r\nios();\r\n// #endif\r\n", desktopPlay))
      .toBe("// #region Setup\r\n// #if WITH_IOS\r\n\r\n// #endif\r\n");
  });

  it.each([
    [["// #if WITH_DESKTOP", "x();"], "game.ts:1: #if without #endif."],
    [["// #endif"], "game.ts:1: #endif without #if."],
    [["// #else"], "game.ts:1: #else without #if."],
    [["// #elif WITH_WEB"], "game.ts:1: #elif without #if."],
    [["// #if WITH_WEB", "// #else", "// #elif WITH_IOS", "// #endif"], "game.ts:3: #elif after #else."],
    [["// #if WITH_WEB", "// #else", "// #else", "// #endif"], "game.ts:3: A second #else."],
    [["// #if WITH_WEB", "// #else WITH_IOS", "// #endif"], "game.ts:2: #else takes no condition; use #elif."],
    [["// #if WITH_WEB", "// #endif WITH_WEB"], "game.ts:2: #endif takes no condition."],
    [["// #if WITH_XBOX", "// #endif"], "game.ts:1: Unknown platform symbol WITH_XBOX"],
  ])("rejects %j", (lines, message) => {
    expect(() => applyPlatformDirectives(lines.join("\n"), desktopPlay, "game.ts")).toThrow(message);
  });
});

describe("platformModuleCondition", () => {
  it("returns the condition of a file that is one whole region, blank lines around it allowed", () => {
    expect(platformModuleCondition("\n// #if WITH_DESKTOP && !WITH_LINUX\nexport const a = 1;\n// #endif\n\n")).toBe("WITH_DESKTOP && !WITH_LINUX");
  });

  it("returns null for a file without directives", () => {
    expect(platformModuleCondition("// #region a\nexport const a = 1;\n// #endregion\n")).toBeNull();
  });

  it.each([
    ["import x from \"y\";\n// #if WITH_DESKTOP\nx();\n// #endif\n"],
    ["// #if WITH_DESKTOP\nx();\n// #endif\ny();\n"],
    ["// #if WITH_DESKTOP\n// #if WITH_WINDOWS\nx();\n// #endif\n// #endif\n"],
    ["// #if WITH_DESKTOP\nx();\n// #else\ny();\n// #endif\n"],
  ])("rejects inline directives in engine code: %j", (source) => {
    expect(() => platformModuleCondition(source, "render.ts")).toThrow("render.ts:");
  });

  it("rejects a whole-file region with an unknown symbol", () => {
    expect(() => platformModuleCondition("// #if WITH_SWITCH\nx();\n// #endif\n")).toThrow("Unknown platform symbol WITH_SWITCH");
  });
});
