import releaseVersion from "../../../release/version.json" with { type: "json" };

/** Plugin authoring compatibility uses the editor's declared application version. */
export const ENGINE_VERSION = releaseVersion.version;
