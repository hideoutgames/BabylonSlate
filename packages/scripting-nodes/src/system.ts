import {
  pin,
  enumRef,
  type NodeDefinition,
  BOOL,
  EXEC,
  FLOAT,
  STRING,
  VEC2,
  ENGINE_PLATFORM_ENUM_ID,
} from "@haptic/scripting";

/**
 * System: global nodes with no Target about where the game runs and what it may ask
 * of the device. The host reports the platform, touch, editor and development flags
 * on Play load; Copy To Clipboard and Open URL are requests the browser may refuse.
 */
export const systemNodes: NodeDefinition[] = [
  {
    id: "system.getPlatform",
    title: "Get Platform",
    category: "system",
    description: "Returns the operating system of the device the game runs on.",
    searchAliases: ["os", "operating system", "device", "ios", "android", "windows", "mac", "linux"],
    pure: true,
    pins: () => [pin("platform", "Platform", "out", enumRef(ENGINE_PLATFORM_ENUM_ID))],
    codegen: () => ({ platform: "ctx.getPlatform()" }),
  },
  {
    id: "system.isTouchDevice",
    title: "Is Touch Device",
    category: "system",
    description: "Returns true when the device has a touch screen.",
    searchAliases: ["touch screen", "mobile", "tablet", "phone"],
    pure: true,
    pins: () => [pin("touchDevice", "Touch Device", "out", BOOL)],
    codegen: () => ({ touchDevice: "ctx.isTouchDevice()" }),
  },
  {
    id: "system.isInEditor",
    title: "Is In Editor",
    category: "system",
    description: "Returns true while the game runs inside the editor, in Play or Simulate.",
    searchAliases: ["editor", "play in editor", "pie"],
    pure: true,
    pins: () => [pin("inEditor", "In Editor", "out", BOOL)],
    codegen: () => ({ inEditor: "ctx.isInEditor()" }),
  },
  {
    id: "system.isDevelopmentBuild",
    title: "Is Development Build",
    category: "system",
    description: "Returns true unless the game is a release export, where Development Only nodes are left out.",
    searchAliases: ["debug", "release", "shipping", "development only"],
    pure: true,
    pins: () => [pin("developmentBuild", "Development Build", "out", BOOL)],
    codegen: () => ({ developmentBuild: "ctx.isDevelopmentBuild()" }),
  },
  {
    id: "system.getViewportSize",
    title: "Get Viewport Size",
    category: "system",
    description: "Returns the size of the game view in pixels and its aspect ratio.",
    searchAliases: ["screen size", "resolution", "window size", "canvas", "aspect"],
    pure: true,
    pins: () => [
      pin("size", "Size", "out", VEC2),
      pin("aspectRatio", "Aspect Ratio", "out", FLOAT),
    ],
    // Both outputs of one statement read the same size.
    codegen: (ctx) => {
      const size = ctx.shared?.("ctx.getViewportSize()") ?? "ctx.getViewportSize()";
      return {
        size,
        aspectRatio: `((s) => (s.y > 0 ? s.x / s.y : 0))(${size})`,
      };
    },
  },
  {
    id: "system.getLocale",
    title: "Get Locale",
    category: "system",
    description: "Returns the player's locale, such as en-US, and its language, such as en.",
    searchAliases: ["language", "localization", "localisation", "region", "culture"],
    pure: true,
    pins: () => [
      pin("locale", "Locale", "out", STRING),
      pin("language", "Language", "out", STRING),
    ],
    codegen: (ctx) => {
      const locale = ctx.shared?.("ctx.getLocale()") ?? "ctx.getLocale()";
      return { locale: `(${locale}).locale`, language: `(${locale}).language` };
    },
  },
  {
    id: "system.newGuid",
    title: "New GUID",
    category: "system",
    description: "Returns a new random identifier, different every time the node runs.",
    searchAliases: ["uuid", "unique id", "identifier", "random id"],
    pure: true,
    pins: () => [pin("guid", "GUID", "out", STRING)],
    codegen: () => ({ guid: "ctx.newGuid()" }),
  },
  {
    id: "system.copyToClipboard",
    title: "Copy To Clipboard",
    category: "system",
    description: "Asks the device to copy text to the clipboard. The browser may refuse without a recent tap or click.",
    searchAliases: ["clipboard", "copy", "share"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("text", "Text", "in", STRING, "data", true, ""),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.copyToClipboard(${ctx.input("text")});`);
    },
  },
  {
    id: "system.openUrl",
    title: "Open URL",
    category: "system",
    description: "Opens a web address in a new browser tab. Only http and https addresses open; the browser may block it without a recent tap or click.",
    searchAliases: ["link", "website", "browser", "web page", "hyperlink"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("url", "URL", "in", STRING, "data", true, "https://"),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.openUrl(${ctx.input("url")});`);
    },
  },
  {
    id: "system.quitGame",
    title: "Quit Game",
    category: "system",
    description: "Ends the game after the current step: Play stops in the editor, and an exported game stops.",
    searchAliases: ["exit", "quit", "close", "end game", "stop"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
    ],
    codegen: (ctx) => {
      ctx.emit("ctx.quitGame();");
    },
  },
];
