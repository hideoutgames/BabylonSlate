import { pin, STRING, type NodeDefinition } from "@haptic/scripting";

/** Nodes of Rich Text 2D Letter Effect and Decorator Classes; the editor offers them only in those lineages. */
export const richTextNodes: NodeDefinition[] = [
  {
    id: "richText.getTagValue",
    title: "Get Tag Value",
    category: "rich-text",
    description: "The value the current tag sets for Key: a keyword Get Keys lists, or in Decorate any keyword of the tag. Empty when it sets none.",
    pure: true,
    pins: () => [
      pin("key", "Key", "in", STRING),
      pin("value", "Value", "out", STRING),
    ],
    codegen: (ctx) => ({ value: `ctx.getRichTextTagValue(${ctx.input("key")})` }),
  },
];
