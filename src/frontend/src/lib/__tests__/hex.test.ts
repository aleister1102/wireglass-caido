import { hexDump, hexString } from "../hex";

describe("hexDump", () => {
  it("prints offset, 8 + 8 hex bytes, and printable ASCII, then the length", () => {
    const bytes = Uint8Array.from([0x43, 0x50, 0x01, 0xf7, 0x5b, 0x14, 0x3c, 0x00, 0x00, 0x01, 0xa5, 0x00, 0x00, 0x01, 0x7f, 0x02, 0x7b, 0x7e]);
    expect(hexDump(bytes)).toBe(
      [
        "00000000  43 50 01 f7 5b 14 3c 00  00 01 a5 00 00 01 7f 02  |CP..[.<.........|",
        "00000010  7b 7e                                             |{~|",
        "00000012",
      ].join("\n"),
    );
  });

  it("prints only the length for an empty frame", () => {
    expect(hexDump(new Uint8Array())).toBe("00000000");
  });
});

describe("hexString", () => {
  it("joins the bytes as lowercase hex", () => {
    expect(hexString(Uint8Array.from([0x43, 0x50, 0x01, 0xf7, 0x00]))).toBe("435001f700");
  });
});
