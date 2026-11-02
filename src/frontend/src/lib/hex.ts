const HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, "0"));
const ASCII = Array.from({ length: 256 }, (_, b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."));

/** `hexdump -C` layout: 8-digit hex offset, 16 bytes split 8 + 8, then printable ASCII. */
export function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let start = 0; start < bytes.length; start += 16) {
    const row = bytes.subarray(start, start + 16);
    let hex = "";
    let ascii = "";
    for (let i = 0; i < 16; i++) {
      if (i === 8) hex += " ";
      hex += i < row.length ? `${HEX[row[i]!]} ` : "   ";
      if (i < row.length) ascii += ASCII[row[i]!];
    }
    lines.push(`${start.toString(16).padStart(8, "0")}  ${hex} |${ascii}|`);
  }
  lines.push(bytes.length.toString(16).padStart(8, "0"));
  return lines.join("\n");
}

/** The bytes as one lowercase hex string with no separators. */
export function hexString(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b];
  return out;
}
