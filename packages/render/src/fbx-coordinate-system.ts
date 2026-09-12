/** AssimpJS 0.0.10 exports source coordinates without FBX global axis/unit metadata. */
export function fbxCoordinateMatrix(bytes: Uint8Array): number[] {
  const values = new Map<string, number>();
  const decoder = new TextDecoder();
  const binary =
    decoder.decode(bytes.subarray(0, 18)) === "Kaydara FBX Binary ";
  if (binary) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const wide = view.getUint32(23, true) >= 7500;
    const word = wide ? 8 : 4;
    const header = word * 3 + 1;
    const integer = (offset: number) =>
      wide
        ? Number(view.getBigUint64(offset, true))
        : view.getUint32(offset, true);
    const visit = (start: number, limit: number, path: string[]) => {
      let offset = start;
      while (offset + header <= limit) {
        const end = integer(offset);
        if (!end) break;
        if (!Number.isSafeInteger(end) || end <= offset || end > limit)
          throw new Error("Invalid FBX node bounds.");
        const count = integer(offset + word);
        const length = integer(offset + word * 2);
        const nameLength = view.getUint8(offset + word * 3);
        const name = decoder.decode(
          bytes.subarray(offset + header, offset + header + nameLength),
        );
        let property = offset + header + nameLength;
        const children = property + length;
        if (children > end) throw new Error("Invalid FBX property bounds.");
        if (path.join("/") === "GlobalSettings/Properties70" && name === "P") {
          const properties: (string | number)[] = [];
          for (let i = 0; i < count; i++) {
            const type = String.fromCharCode(view.getUint8(property++));
            if (type === "S") {
              const size = view.getUint32(property, true);
              property += 4;
              properties.push(
                decoder.decode(bytes.subarray(property, property + size)),
              );
              property += size;
            } else if (type === "I") {
              properties.push(view.getInt32(property, true));
              property += 4;
            } else if (type === "D") {
              properties.push(view.getFloat64(property, true));
              property += 8;
            } else {
              break;
            }
            if (property > children)
              throw new Error("Invalid FBX property bounds.");
          }
          if (
            typeof properties[0] === "string" &&
            typeof properties[4] === "number"
          )
            values.set(properties[0], properties[4]);
        } else if (
          (path.length === 0 && name === "GlobalSettings") ||
          (path[0] === "GlobalSettings" && name === "Properties70")
        ) {
          visit(children, end, [...path, name]);
        }
        offset = end;
      }
    };
    visit(27, bytes.byteLength, []);
  } else {
    const text = decoder.decode(bytes);
    const settings =
      /GlobalSettings\s*:\s*\{[\s\S]*?Properties70\s*:\s*\{([\s\S]*?)\}/.exec(
        text,
      )?.[1] ?? "";
    for (const match of settings.matchAll(
      /P\s*:\s*"([^"]+)"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*([-+\deE.]+)/g,
    ))
      values.set(match[1]!, Number(match[2]));
  }
  const scale = (values.get("UnitScaleFactor") ?? 1) / 100;
  const axes = [
    values.get("CoordAxis") ?? 0,
    values.get("UpAxis") ?? 1,
    values.get("FrontAxis") ?? 2,
  ];
  const signs = [
    values.get("CoordAxisSign") ?? 1,
    values.get("UpAxisSign") ?? 1,
    -(values.get("FrontAxisSign") ?? -1),
  ];
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    new Set(axes).size !== 3 ||
    axes.some((axis) => ![0, 1, 2].includes(axis)) ||
    signs.some((sign) => Math.abs(sign) !== 1)
  )
    throw new Error("Unsupported FBX global coordinate settings.");
  const matrix = Array<number>(16).fill(0);
  for (let row = 0; row < 3; row++)
    matrix[axes[row]! * 4 + row] = signs[row]! * scale;
  matrix[15] = 1;
  return matrix;
}
