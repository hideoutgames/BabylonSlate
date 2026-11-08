import type { ProjectStorage } from "@haptic/core";
import { ASSETS_DIR } from "./hproject";

/**
 * Content roots make the registry root-aware from the first commit
 * (engineplan §10.2): the project root, one per enabled plugin, one per
 * enabled gameplay (not Editor Only) extension, and a synthetic kind for tests
 * that exercise a second root without a real plugin.
 */
export type ContentRootKind = "project" | "plugin" | "extension" | "synthetic";

export interface ContentRoot {
  id: string;
  kind: ContentRootKind;
  /** Path prefix inside ProjectStorage holding this root's `.hasset` tree. */
  pathPrefix: string;
  /** Engine plugin and extension roots refuse create/delete/move. */
  readOnly?: boolean;
  /** Engine plugins and extensions mount from a separate storage; defaults to the registry's. */
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

/** `extension:<extensionGuid>`, the root of a gameplay extension's `assets/` folder. */
export function extensionContentRootId(extensionGuid: string): string {
  return `extension:${extensionGuid}`;
}

export function extensionContentRoot(options: {
  extensionGuid: string;
  pathPrefix: string;
  readOnly?: boolean;
  storage?: ProjectStorage;
}): ContentRoot {
  return {
    id: extensionContentRootId(options.extensionGuid),
    kind: "extension",
    pathPrefix: options.pathPrefix,
    readOnly: options.readOnly,
    storage: options.storage,
  };
}
