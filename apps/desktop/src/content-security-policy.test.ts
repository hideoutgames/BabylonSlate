import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { editorContentSecurityPolicy, inlineScriptHashes, playerContentSecurityPolicy } from "./content-security-policy";

function directives(policy: string): Map<string, string[]> {
  return new Map(policy.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));
}

describe("desktop content security policies", () => {
  it("allows exactly the editor page's inline scripts, by hash", () => {
    const html = `<head><script src="/coi-serviceworker.js"></script>\n<script>boot();</script><style>a{}</style></head>`
      + `<body><script type="module" crossorigin src="/assets/index.js"></script><SCRIPT>\nintro()\n</SCRIPT></body>`;
    const sha = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
    expect(inlineScriptHashes(html)).toEqual([sha("boot();"), sha("\nintro()\n")]);
    const script = directives(editorContentSecurityPolicy(inlineScriptHashes(html))).get("script-src")!;
    expect(script).toEqual(expect.arrayContaining([sha("boot();"), sha("\nintro()\n")]));
    // A hash source alone never re-enables inline script.
    expect(script).not.toContain("'unsafe-inline'");
  });

  it("keeps the editor's plugins, base, forms and embedding shut while frames stay limited to Preview and billing", () => {
    const policy = directives(editorContentSecurityPolicy([]));
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("form-action")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("frame-src")).toContain("app://preview");
    expect(policy.get("frame-src")).not.toContain("https:");
    expect(policy.get("frame-src")).not.toContain("*");
  });

  it("lets games and Preview connect to any HTTPS or secure WebSocket host but load scripts and frames only from themselves", () => {
    const shared = "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; "
      + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data: blob:; "
      + "connect-src 'self' data: blob: https: wss:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; ";
    // A game behaves the same in Preview as exported: only who may embed it differs.
    expect(playerContentSecurityPolicy("app://babylonslate")).toBe(`${shared}frame-ancestors app://babylonslate`);
    expect(playerContentSecurityPolicy("'none'")).toBe(`${shared}frame-ancestors 'none'`);
    for (const plain of ["http:", "ws:", "*"]) {
      expect(playerContentSecurityPolicy("'none'").split(/[\s;]+/)).not.toContain(plain);
    }
  });

  // The iOS and Android game templates are compiled by Xcode and Gradle, so they hold their own copy of the exported
  // game's policy; this source-read check is the contract that keeps each copy identical to it.
  it.each([
    ["the iOS game template", "../ios-game/HapticGame/HapticGameApp.swift", /static let contentSecurityPolicy = "([^"\\]*)"/],
    ["the Android game template", "../android-game/app/src/main/java/com/haptic/game/GameActivity.java", /CONTENT_SECURITY_POLICY = "([^"\\]*)";/],
  ])("gives %s the exported desktop game's policy", (_name, file, pattern) => {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    const copies = [...source.matchAll(new RegExp(pattern, "g"))];
    expect(copies).toHaveLength(1);
    expect(copies[0]![1]).toBe(playerContentSecurityPolicy("'none'"));
  });
});
