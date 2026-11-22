/** A pin as its row appears in a node page's Inputs or Outputs table. */
export type DocsPin = { label: string; glyph: string };

export type NodePreview = {
  /** The node drawn by the editor's node component; every graph except Behaviour Tree decorators and services. */
  html?: string;
  inputs: DocsPin[];
  outputs: DocsPin[];
};

/** Keyed by `<graph folder>/<node id>`, for example `class/flow.branch`. */
export type NodePreviews = Record<string, NodePreview>;
