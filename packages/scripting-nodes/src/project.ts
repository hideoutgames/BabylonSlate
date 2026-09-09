import { pin, STRING, type NodeDefinition } from "@babylonslate/scripting";

/** Authored identity, available equally in Play and packaged games. */
export const projectNodes: NodeDefinition[] = [
  {
    id: "project.getName",
    title: "Get Project Name",
    category: "project",
    pure: true,
    pins: () => [pin("name", "Name", "out", STRING)],
    codegen: () => ({ name: "ctx.getProjectName()" }),
  },
  {
    id: "project.getVersion",
    title: "Get Project Version",
    category: "project",
    pure: true,
    pins: () => [pin("version", "Version", "out", STRING)],
    codegen: () => ({ version: "ctx.getProjectVersion()" }),
  },
];
