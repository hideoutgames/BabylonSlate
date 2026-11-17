import { pin, STRING, type NodeDefinition } from "@haptic/scripting";

/** Nodes of Rich Text 2D Decorator Effect Classes; the editor offers them only in that lineage. */
export const richTextNodes: NodeDefinition[] = [
  {
    id: "richText.getTagValue",
    title: "Get Tag Value",
    category: "rich-text",
    description: "The value the current [fx] tag sets for Key, a keyword Get Keys lists. Empty when it sets none.",
    pure: true,
    pins: () => [
      pin("key", "Key", "in", STRING),
      pin("value", "Value", "out", STRING),
    ],
    codegen: (ctx) => ({ value: `ctx.getRichTextTagValue(${ctx.input("key")})` }),
  },
];
