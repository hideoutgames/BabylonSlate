import { EXEC, pin, STRING, type NodeDefinition } from "@haptic/scripting";

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
  {
    id: "project.getThirdPartyNotices",
    title: "Get Third-Party Notices",
    category: "project",
    latent: true,
    description:
      "Reads the licence notices of the open-source software the game runs on, the same text exported games ship in legal/THIRD-PARTY-NOTICES.txt, for a credits or legal screen. Runs Failed with an Error when the notices cannot be read.",
    searchAliases: ["licence", "license", "licenses", "legal", "credits", "open source", "attribution", "notices"],
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("completed", "Completed", "out", EXEC),
      pin("failed", "Failed", "out", EXEC),
      pin("notices", "Notices", "out", STRING),
      pin("error", "Error", "out", STRING),
    ],
    codegen: ctx => {
      const result = `__notices_${ctx.node.id.replace(/[^A-Za-z0-9_$]/g, "_")}`;
      ctx.emit(`const ${result} = await ctx.getThirdPartyNotices();`);
      ctx.emit(`${ctx.output("notices")} = ${result}.text;`);
      ctx.emit(`${ctx.output("error")} = ${result}.errorMessage;`);
      ctx.branch?.(`${result}.success`, "Completed", "Failed");
    },
  },
];
