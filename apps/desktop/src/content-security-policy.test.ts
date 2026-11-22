import { createHash } from "node:crypto";
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

  it("runs the player's compiled scripts and WebAssembly but reaches no network, and only the editor embeds Preview", () => {
    const preview = directives(playerContentSecurityPolicy("app://babylonslate"));
    expect(preview.get("script-src")).toEqual(["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'"]);
    expect(preview.get("connect-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(preview.get("frame-ancestors")).toEqual(["app://babylonslate"]);
    expect(directives(playerContentSecurityPolicy("'none'")).get("frame-ancestors")).toEqual(["'none'"]);
  });
});
