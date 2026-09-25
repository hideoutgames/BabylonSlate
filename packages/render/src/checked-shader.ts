type Replacement = string | ((match: string, ...groups: string[]) => string);

/** Babylon 9.20 shader adaptation contract: reject changed hooks before compiling. */
export function checkedShader(source: string, label: string) {
  return {
    value: source,
    /**
     * `expected` is the total occurrence count of `search`. Only the first
     * match is replaced unless `search` is a global RegExp.
     */
    replace(search: string | RegExp, replacement: Replacement, expected = 1) {
      const count =
        typeof search === "string"
          ? this.value.split(search).length - 1
          : Array.from(
              this.value.matchAll(
                new RegExp(
                  search.source,
                  search.flags.includes("g")
                    ? search.flags
                    : `${search.flags}g`,
                ),
              ),
            ).length;
      if (count !== expected)
        throw new Error(
          `Shader adapter contract failed (${label}): expected ${expected} matches for ${String(search)}, found ${count}. Review the Babylon shader adapter.`,
        );
      this.value =
        typeof replacement === "string"
          ? this.value.replace(search, replacement)
          : this.value.replace(search, replacement);
      return this;
    },
    replaceAll(search: string, replacement: string, expected: number) {
      const count = this.value.split(search).length - 1;
      if (count !== expected)
        throw new Error(
          `Shader adapter contract failed (${label}): expected ${expected} matches for ${search}, found ${count}. Review the Babylon shader adapter.`,
        );
      this.value = this.value.replaceAll(search, replacement);
      return this;
    },
  };
}
