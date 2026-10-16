import type { NodePreviews } from "./types";

type Token = {
  type: string;
  tag: string;
  content: string;
  children: Token[] | null;
};

type CoreState = {
  tokens: Token[];
  env: { relativePath?: string; frontmatter?: Record<string, unknown> };
  Token: new (type: string, tag: string, nesting: -1 | 0 | 1) => Token;
};

type MarkdownIt = {
  core: { ruler: { push: (name: string, rule: (state: CoreState) => void) => void } };
};

const NODE_PAGE = /^scripting\/([^/]+)\/[^/]+\.md$/;

/** Inline text of the next `inline` token after `index`. */
function inlineAfter(tokens: Token[], index: number): Token | undefined {
  for (let i = index + 1; i < tokens.length; i++) {
    if (tokens[i]!.type === "inline") return tokens[i];
  }
  return undefined;
}

/**
 * Node reference pages name their catalog node in `node:` frontmatter. This
 * draws Class and Material nodes as the editor does, under the page summary,
 * and puts the graph's pin glyph before each type in the Inputs and Outputs
 * tables of every node page. A
 * `node:` that is not in the catalog, or a table row that is not one of the
 * node's pins, fails the build so the pages cannot drift from the editor.
 */
export function installNodePreviews(md: MarkdownIt, previews: NodePreviews): void {
  md.core.ruler.push("haptic_node_preview", (state) => {
    const node = state.env.frontmatter?.node;
    if (node === undefined) return;
    const page = state.env.relativePath ?? "";
    const graph = NODE_PAGE.exec(page)?.[1];
    const preview = graph ? previews[`${graph}/${String(node)}`] : undefined;
    if (!preview) throw new Error(`${page}: node "${String(node)}" is not a ${graph ?? "graph"} catalog node`);

    const { tokens } = state;
    if (preview.html) {
      const titleEnd = tokens.findIndex((token) => token.type === "heading_close" && token.tag === "h1");
      const summaryEnd = tokens.findIndex((token, i) => i > titleEnd && token.type === "paragraph_close");
      const html = new state.Token("html_block", "", 0);
      html.content = `${preview.html}\n`;
      tokens.splice((summaryEnd >= 0 ? summaryEnd : titleEnd) + 1, 0, html);
    }

    const problems: string[] = [];
    let section = "";
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.type === "heading_open" && token.tag === "h2") section = inlineAfter(tokens, i)?.content ?? "";
      if (token.type !== "table_open" || (section !== "Inputs" && section !== "Outputs")) continue;
      const pins = [...(section === "Inputs" ? preview.inputs : preview.outputs)];
      const header: string[] = [];
      let typeColumn = -1;
      let row: Token[] = [];
      for (i += 1; i < tokens.length && tokens[i]!.type !== "table_close"; i++) {
        const cell = tokens[i]!;
        if (cell.type === "th_open") {
          header.push(inlineAfter(tokens, i)?.content ?? "");
          typeColumn = header.indexOf("Type");
        } else if (cell.type === "td_open") {
          row.push(inlineAfter(tokens, i)!);
        } else if (cell.type === "tr_close" && row.length > 0) {
          const label = row[0]!.content.trim();
          const match = pins.findIndex((pin) => pin.label === label);
          const typeCell = row[typeColumn];
          if (match < 0 || !typeCell) {
            problems.push(`${section} row "${label}" is not a pin of ${String(node)}`);
          } else {
            const glyph = new state.Token("html_inline", "", 0);
            glyph.content = pins[match]!.glyph;
            typeCell.children = [glyph, ...(typeCell.children ?? [])];
            pins.splice(match, 1);
          }
          row = [];
        }
      }
    }
    if (problems.length > 0) throw new Error(`${page}:\n  ${problems.join("\n  ")}`);
  });
}
