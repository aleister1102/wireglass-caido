// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import {
  MAX_FIELDS,
  MAX_FILE_BYTES,
  MAX_IDENTIFIER_LENGTH,
  MAX_JSON_DEPTH,
  MAX_LABEL_LENGTH,
  MAX_LAYOUT_ENTRIES,
  MAX_LAYOUT_ID_LENGTH,
  MAX_RECORD_LENGTH,
  MAX_RECORD_TYPE,
  MAX_REJECT_PAYLOAD_LENGTH,
  MAX_TABLE_ENTRIES,
  MAX_TABLES,
  checkLayoutFileSize,
  decodeLayoutBytes,
  escapeLayoutText,
  validateLayoutText,
  type LayoutIssue,
} from "../layout";

/** A minimal valid layout; tests substitute parts of it. */
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1,
    id: "sample",
    name: "Sample",
    version: 1,
    fields: [{ name: "magic", type: "u16", endian: "be", expect: 17232 }],
    ...overrides,
  };
}

function text(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(base(overrides));
}

function issuesOf(source: string): LayoutIssue[] {
  const result = validateLayoutText(source);
  return result.ok ? [] : [...result.issues];
}

function expectIssue(source: string, code: LayoutIssue["code"], pointer: string): void {
  const issues = issuesOf(source);
  expect(issues.map((issue) => [issue.code, issue.pointer])).toContainEqual([code, pointer]);
}

function fieldsOf(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({ name: `f${index}`, type: "u8" }));
}

describe("policy constants", () => {
  it("keeps the approved values", () => {
    expect(MAX_FILE_BYTES).toBe(1_048_576);
    expect(MAX_JSON_DEPTH).toBe(16);
    expect(MAX_FIELDS).toBe(64);
    expect(MAX_TABLES).toBe(64);
    expect(MAX_TABLE_ENTRIES).toBe(4096);
    expect(MAX_LAYOUT_ENTRIES).toBe(16_384);
    expect(MAX_IDENTIFIER_LENGTH).toBe(64);
    expect(MAX_LAYOUT_ID_LENGTH).toBe(48);
    expect(MAX_LABEL_LENGTH).toBe(80);
    expect(MAX_REJECT_PAYLOAD_LENGTH).toBe(200);
    expect(MAX_RECORD_TYPE).toBe(255);
    expect(MAX_RECORD_LENGTH).toBe(65_535);
  });
});

describe("file size cap", () => {
  it("accepts a file at the cap and rejects one byte more", () => {
    expect(checkLayoutFileSize(MAX_FILE_BYTES)).toBeNull();
    expect(checkLayoutFileSize(MAX_FILE_BYTES + 1)?.code).toBe("file-too-large");
  });

  it("validates text at the cap and rejects text one byte over", () => {
    const body = text();
    const atCap = body + " ".repeat(MAX_FILE_BYTES - body.length);
    expect(validateLayoutText(atCap).ok).toBe(true);
    expect(issuesOf(atCap + " ")[0]?.code).toBe("file-too-large");
  });

  it("checks bytes before decoding", () => {
    const result = decodeLayoutBytes(new Uint8Array(MAX_FILE_BYTES + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("file-too-large");
  });
});

describe("depth cap", () => {
  it("accepts nesting of exactly the cap (root is depth 1)", () => {
    const source = "[".repeat(MAX_JSON_DEPTH) + "]".repeat(MAX_JSON_DEPTH);
    expect(issuesOf(source).some((issue) => issue.code === "depth-exceeded")).toBe(false);
  });

  it("rejects one level more, at the first pointer past the cap", () => {
    const source = "[".repeat(MAX_JSON_DEPTH + 1) + "]".repeat(MAX_JSON_DEPTH + 1);
    expectIssue(source, "depth-exceeded", "/0".repeat(MAX_JSON_DEPTH));
  });
});

describe("fields cap", () => {
  it("accepts 64 fields and rejects 65", () => {
    expect(validateLayoutText(text({ fields: fieldsOf(MAX_FIELDS) })).ok).toBe(true);
    expectIssue(text({ fields: fieldsOf(MAX_FIELDS + 1) }), "invalid-file", "/fields");
  });
});

describe("table caps", () => {
  const table = (id: string, count: number) => ({
    id,
    entries: Array.from({ length: count }, (_, index) => ({ value: index, name: `e${index}` })),
  });

  it("accepts 64 tables and rejects 65", () => {
    const tables = Array.from({ length: MAX_TABLES }, (_, index) => table(`t${index}`, 0));
    expect(validateLayoutText(text({ tables })).ok).toBe(true);
    expectIssue(text({ tables: [...tables, table("extra", 0)] }), "invalid-file", "/tables");
  });

  it("accepts 4096 entries in a table and rejects 4097", () => {
    expect(validateLayoutText(text({ tables: [table("t", MAX_TABLE_ENTRIES)] })).ok).toBe(true);
    expectIssue(text({ tables: [table("t", MAX_TABLE_ENTRIES + 1)] }), "invalid-file", "/tables/0/entries");
  });

  it("accepts 16384 entries in a layout and rejects 16385", () => {
    const full = [table("a", 4096), table("b", 4096), table("c", 4096), table("d", 4096)];
    expect(validateLayoutText(text({ tables: full })).ok).toBe(true);
    expectIssue(text({ tables: [...full, table("e", 1)] }), "invalid-file", "/tables");
  });
});

describe("identifier cap", () => {
  it("accepts a 64-character field name and rejects 65", () => {
    const ok = "a".repeat(MAX_IDENTIFIER_LENGTH);
    const tooLong = "a".repeat(MAX_IDENTIFIER_LENGTH + 1);
    expect(validateLayoutText(text({ fields: [{ name: ok, type: "u8" }] })).ok).toBe(true);
    expectIssue(text({ fields: [{ name: tooLong, type: "u8" }] }), "invalid-file", "/fields/0/name");
  });

  it("applies the same cap to table IDs", () => {
    const tooLong = "t".repeat(MAX_IDENTIFIER_LENGTH + 1);
    expectIssue(text({ tables: [{ id: tooLong, entries: [] }] }), "invalid-file", "/tables/0/id");
  });
});

describe("layout ID cap", () => {
  it("accepts 48 characters and rejects 49", () => {
    const ok = "a" + "b".repeat(MAX_LAYOUT_ID_LENGTH - 1);
    const tooLong = "a" + "b".repeat(MAX_LAYOUT_ID_LENGTH);
    expect(validateLayoutText(text({ id: ok })).ok).toBe(true);
    expectIssue(text({ id: tooLong }), "invalid-file", "/id");
  });
});

describe("label cap", () => {
  it("accepts 80 characters in the layout name and rejects 81", () => {
    expect(validateLayoutText(text({ name: "n".repeat(MAX_LABEL_LENGTH) })).ok).toBe(true);
    expectIssue(text({ name: "n".repeat(MAX_LABEL_LENGTH + 1) }), "invalid-file", "/name");
  });
});

describe("rejectPayload cap", () => {
  const withReject = (rejectPayload: string) =>
    text({
      records: {
        countField: "f0",
        length: "u8-escape-u16",
        types: [{ type: 6, name: "enc", display: "hex", rejectPayload }],
      },
      fields: [{ name: "f0", type: "u8" }],
    });

  it("accepts 200 characters and rejects 201", () => {
    expect(validateLayoutText(withReject("r".repeat(MAX_REJECT_PAYLOAD_LENGTH))).ok).toBe(true);
    expectIssue(
      withReject("r".repeat(MAX_REJECT_PAYLOAD_LENGTH + 1)),
      "invalid-file",
      "/records/types/0/rejectPayload",
    );
  });
});

describe("record type and length caps", () => {
  const withType = (type: number, length?: number) =>
    text({
      fields: [{ name: "f0", type: "u8" }],
      records: {
        countField: "f0",
        length: "u8-escape-u16",
        types: [{ type, name: "r", display: "hex", ...(length === undefined ? {} : { length }) }],
      },
    });

  it("accepts record type 255 and rejects 256", () => {
    expect(validateLayoutText(withType(MAX_RECORD_TYPE)).ok).toBe(true);
    expectIssue(withType(MAX_RECORD_TYPE + 1), "invalid-file", "/records/types/0/type");
  });

  it("accepts record length 65535 and rejects 65536", () => {
    expect(validateLayoutText(withType(0, MAX_RECORD_LENGTH)).ok).toBe(true);
    expectIssue(withType(0, MAX_RECORD_LENGTH + 1), "invalid-file", "/records/types/0/length");
  });
});

describe("error classes and pointers", () => {
  it("reports invalid JSON with a parser message", () => {
    expect(issuesOf("{ nope").map((issue) => issue.code)).toEqual(["invalid-json"]);
  });

  it("rejects comments and trailing commas as invalid JSON", () => {
    expect(issuesOf('{"format":1,}')[0]?.code).toBe("invalid-json");
    expect(issuesOf('{/*c*/"format":1}')[0]?.code).toBe("invalid-json");
  });

  it("rejects a duplicate key at its pointer", () => {
    expectIssue('{"format":1,"format":1}', "duplicate-key", "/format");
  });

  it("rejects an unknown key at its pointer", () => {
    expectIssue(text({ extra: true }), "unknown-key", "/extra");
    expectIssue(text({ fields: [{ name: "f0", type: "u8", extra: 1 }] }), "unknown-key", "/fields/0/extra");
  });

  it("treats __proto__ as an unknown key and never pollutes the prototype", () => {
    const source = '{"__proto__":{"polluted":1},"format":1,"id":"x","name":"x","version":1,"fields":[]}';
    expectIssue(source, "unknown-key", "/__proto__");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("requires format 1 with a pointer", () => {
    expectIssue(text({ format: 2 }), "invalid-file", "/format");
  });

  it("points endian errors at the field", () => {
    expectIssue(text({ fields: [{ name: "f0", type: "u16" }] }), "invalid-file", "/fields/0");
    expectIssue(text({ fields: [{ name: "f0", type: "u8", endian: "be" }] }), "invalid-file", "/fields/0/endian");
  });

  it("rejects expect outside the field type range", () => {
    expectIssue(text({ fields: [{ name: "f0", type: "u8", expect: 256 }] }), "invalid-file", "/fields/0/expect");
  });

  it("rejects a lookup that names no table", () => {
    expectIssue(
      text({ fields: [{ name: "f0", type: "i32", endian: "be", lookup: "missing" }] }),
      "invalid-file",
      "/fields/0/lookup",
    );
  });

  it("rejects a lookup entry outside its field's range", () => {
    const tables = [{ id: "t", entries: [{ value: 256, name: "big" }] }];
    expectIssue(
      text({ fields: [{ name: "f0", type: "u8", lookup: "t" }], tables }),
      "invalid-file",
      "/tables/0/entries/0/value",
    );
  });

  it("rejects duplicate lookup values in one table", () => {
    const tables = [
      {
        id: "t",
        entries: [
          { value: 1, name: "a" },
          { value: 1, name: "b" },
        ],
      },
    ];
    expectIssue(text({ tables }), "invalid-file", "/tables/0/entries/1/value");
  });

  it("rejects a countField that names a non-count field", () => {
    expectIssue(
      text({
        fields: [{ name: "f0", type: "i32", endian: "be" }],
        records: { countField: "f0", length: "u8-escape-u16", types: [] },
      }),
      "invalid-file",
      "/records/countField",
    );
  });

  it("rejects a payload lengthField that is not u32", () => {
    expectIssue(
      text({
        fields: [{ name: "f0", type: "u8" }],
        payload: { lengthField: "f0" },
      }),
      "invalid-file",
      "/payload/lengthField",
    );
  });

  it("rejects uuid display without length 16 and uint without length 1 to 4", () => {
    expectIssue(
      text({
        fields: [{ name: "f0", type: "u8" }],
        records: { countField: "f0", length: "u8-escape-u16", types: [{ type: 0, name: "u", display: "uuid" }] },
      }),
      "invalid-file",
      "/records/types/0",
    );
    expectIssue(
      text({
        fields: [{ name: "f0", type: "u8" }],
        records: {
          countField: "f0",
          length: "u8-escape-u16",
          types: [{ type: 0, name: "u", display: "uint", length: 5 }],
        },
      }),
      "invalid-file",
      "/records/types/0/length",
    );
  });

  it("rejects duplicate record types", () => {
    expectIssue(
      text({
        fields: [{ name: "f0", type: "u8" }],
        records: {
          countField: "f0",
          length: "u8-escape-u16",
          types: [
            { type: 6, name: "a", display: "hex" },
            { type: 6, name: "b", display: "hex" },
          ],
        },
      }),
      "invalid-file",
      "/records/types/1/type",
    );
  });

  it.each(["__proto__", "constructor", "toString"])("rejects own-key name %s for fields, tables and record types", (name) => {
    expectIssue(text({ fields: [{ name, type: "u8" }] }), "invalid-file", "/fields/0/name");
    expectIssue(
      text({ fields: [{ name: "f0", type: "u8", lookup: name }], tables: [{ id: name, entries: [] }] }),
      "invalid-file",
      "/tables/0/id",
    );
    expectIssue(
      text({
        fields: [{ name: "f0", type: "u8" }],
        records: { countField: "f0", length: "u8-escape-u16", types: [{ type: 1, name, display: "hex" }] },
      }),
      "invalid-file",
      "/records/types/0/name",
    );
  });

  it("accepts names that only contain an own-key name as a substring", () => {
    expect(validateLayoutText(text({ fields: [{ name: "constructor2", type: "u8" }] })).ok).toBe(true);
  });

  it("accepts a bidi override and a C0 control in display names", () => {
    expect(validateLayoutText(text({ name: "evil\u202Eabc" })).ok).toBe(true);
    expect(
      validateLayoutText(
        text({
          fields: [{ name: "f0", type: "u8" }],
          records: { countField: "f0", length: "u8-escape-u16", types: [{ type: 1, name: "a\u0007b", display: "hex" }] },
        }),
      ).ok,
    ).toBe(true);
  });

  it("escapes control and bidi characters for display and leaves tag-like text unchanged", () => {
    expect(escapeLayoutText("evil\u202Eabc")).toBe("evil\\u{202E}abc");
    expect(escapeLayoutText("a\u0007b")).toBe("a\\u{0007}b");
    expect(escapeLayoutText("<b>x</b>")).toBe("<b>x</b>");
  });

  it("rejects a reserved layout ID", () => {
    expectIssue(text({ id: "json" }), "invalid-file", "/id");
  });

  it("rejects version 0 at its pointer", () => {
    expectIssue(text({ version: 0 }), "invalid-file", "/version");
  });

  it("rejects a countField that names no declared field", () => {
    expectIssue(
      text({
        fields: [
          { name: "f0", type: "u8" },
          { name: "f1", type: "u8" },
        ],
        records: { countField: "later", length: "u8-escape-u16", types: [] },
      }),
      "invalid-file",
      "/records/countField",
    );
  });
});

describe("CP example", () => {
  it("validates with no issues", () => {
    const url = new URL("../../../../../examples/layouts/capitalcom-cp.layout.json", import.meta.url);
    const result = validateLayoutText(readFileSync(url, "utf8"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.layout.tables.get("cp_destinations")?.entries.get(-183853945)).toBe("country.getAll.v2");
      expect(result.layout.records?.types.get(13)?.rejectPayload).toContain("handshake");
    }
  });
});

describe("no runtime code generation", () => {
  it("contains no eval, Function constructor or generated schema in the layout code", () => {
    const dir = new URL("../layout/", import.meta.url);
    for (const file of readdirSync(dir)) {
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source, file).not.toMatch(/\beval\s*\(|new\s+Function\b|\bFunction\s*\(/);
    }
  });
});
