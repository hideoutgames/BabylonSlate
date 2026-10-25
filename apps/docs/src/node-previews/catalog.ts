/** Class graph nodes that only exist in Animation Graph event and rule graphs. */
export function scriptGraphFolder(id: string): "animation" | "class" {
  return /^anim\.(event|rule|state)\./.test(id) ? "animation" : "class";
}
