/** Catalog data for a user command; registration does not require its graph. */
export interface ConsoleCommandMetadata {
  /** Empty uses the Class identity converted to lower case. */
  name: string;
  description: string;
  category: string;
  parameters: Array<{
    name: string;
    type: "string" | "float" | "int" | "bool" | "enum";
    optional?: boolean;
    defaultValue?: unknown;
    enumValues?: string[];
  }>;
}

/** Accepts persisted and hydrated graphs; only the typed Command Run event counts. */
export function consoleCommandMetadataFromGraph(graph: unknown, classId = ""): ConsoleCommandMetadata | undefined {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
  const nodes = record(graph).nodes;
  if (!Array.isArray(nodes)) return undefined;
  for (const value of nodes) {
    const node = record(value);
    const data = record(node.data);
    const properties = record(node.properties ?? data.properties ?? data);
    if ((data.__nodeType ?? node.typeId ?? node.type) !== "flow.event.commandRun") continue;
    return {
      name: typeof properties.commandName === "string" && properties.commandName.trim() ? properties.commandName.trim() : classId.toLowerCase(),
      description: typeof properties.description === "string" ? properties.description : "",
      category: typeof properties.category === "string" && properties.category.trim() ? properties.category.trim() : "game",
      parameters: (Array.isArray(properties.parameters) ? properties.parameters : []).flatMap(value => {
        const param = record(value);
        if (typeof param.name !== "string" || !param.name.trim()) return [];
        const valueType = param.type;
        const type: ConsoleCommandMetadata["parameters"][number]["type"] = valueType === "string" || valueType === "int" || valueType === "bool" || valueType === "enum" ? valueType : "float";
        return [{ name: param.name.trim(), type,
          ...(param.optional === true ? { optional: true } : {}),
          ...(param.defaultValue !== undefined ? { defaultValue: param.defaultValue } : {}),
          ...(Array.isArray(param.enumValues) ? { enumValues: param.enumValues.filter((entry): entry is string => typeof entry === "string") } : {}),
        }];
      }),
    };
  }
  return undefined;
}
