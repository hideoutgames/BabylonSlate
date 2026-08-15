import type { ProjectStorage } from "@babylonslate/core";
import { ASSETS_DIR } from "./babproject";

/**
 * Content roots make the registry root-aware from the first commit
 * (engineplan §10.2): the project root plus one per enabled plugin, and a
 * synthetic kind for tests that exercise a second root without a real plugin.
 */
export type ContentRootKind = "project" | "plugin" | "synthetic";

export interface ContentRoot {
  id: string;
  kind: ContentRootKind;
  /** Path prefix inside ProjectStorage holding this root's `.babasset` tree. */
  pathPrefix: string;
  /** Engine plugin roots refuse create/delete/move. */
  readOnly?: boolean;
  /** Engine plugins mount from a separate storage; defaults to the registry's. */
  storage?: ProjectStorage;
}

export function projectContentRoot(id = "project"): ContentRoot {
  return { id, kind: "project", pathPrefix: ASSETS_DIR };
}

export function pluginContentRoot(options: {
  id: string;
  pathPrefix: string;
  readOnly?: boolean;
  storage?: ProjectStorage;
}): ContentRoot {
  return {
    id: options.id,
    kind: "plugin",
    pathPrefix: options.pathPrefix,
    readOnly: options.readOnly,
    storage: options.storage,
  };
}
