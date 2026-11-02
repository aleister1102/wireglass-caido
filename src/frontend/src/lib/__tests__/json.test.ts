import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { compactJson, prettyJson, splitJsonSequence, validateJson } from "../json";
import { jsonHighlight } from "../jsonLanguage";

describe("validateJson", () => {
  it.each(['{"a":1}', "[1,2]", '"text"', "42", "-1.5e10", "true", "null", '  {"a":1}\n'])("accepts complete JSON %s", (text) => {
    expect(validateJson(text).ok).toBe(true);
  });

  it.each([
    ['{"broken": tru', "tru"],
    ['{"a":1} trailing', "trailing data"],
    ['{"a":1}{"b":2}', "second value"],
    ["{'a':1}", "single quotes"],
    ['{"a":1,}', "trailing comma"],
    ['{"a":1} // c', "comment"],
    ["", "empty"],
    ["01", "leading zero"],
    ["plain text, not JSON", "text"],
  ])("rejects %s (%s) with a position", (text) => {
    const result = validateJson(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.offset).toBeGreaterThanOrEqual(0);
  });
});

describe("jsonHighlight", () => {
  const highlighter = tagHighlighter([
    { tag: tags.propertyName, class: "key" },
    { tag: tags.string, class: "string" },
    { tag: tags.number, class: "number" },
    { tag: [tags.bool, tags.null], class: "keyword" },
  ]);
  const classes = (doc: string, from: number) => {
    const state = EditorState.create({ doc, extensions: jsonHighlight(from) });
    const out: [string, string][] = [];
    highlightTree(ensureSyntaxTree(state, doc.length, 5000)!, highlighter, (a, b, cls) => out.push([doc.slice(a, b), cls]));
    return out;
  };

  it("classifies tokens at document positions after a protocol prefix", () => {
    expect(classes('42/chat,["msg",{"k":12345678901234567890,"t":true,"n":null}]', 8)).toEqual([
      ['"msg"', "string"],
      ['"k"', "key"],
      ["12345678901234567890", "number"],
      ['"t"', "key"],
      ["true", "keyword"],
      ['"n"', "key"],
      ["null", "keyword"],
    ]);
  });

  it("classifies every value of a jq output sequence", () => {
    expect(classes('1\n{"a":"b"}\n"c"', 0)).toEqual([
      ["1", "number"],
      ['"a"', "key"],
      ['"b"', "string"],
      ['"c"', "string"],
    ]);
  });
});

describe("formatting", () => {
  const text = '{ "n" : 1.0e10, "dup":1, "dup":2, "s":"a\\"b \\u00e9", "big": 12345678901234567890 }';

  it("compact removes only insignificant whitespace", () => {
    expect(compactJson(text)).toBe('{"n":1.0e10,"dup":1,"dup":2,"s":"a\\"b \\u00e9","big":12345678901234567890}');
  });

  it("pretty keeps tokens, duplicate keys, escapes, and order", () => {
    const pretty = prettyJson(text);
    expect(pretty).toBe('{\n  "n": 1.0e10,\n  "dup": 1,\n  "dup": 2,\n  "s": "a\\"b \\u00e9",\n  "big": 12345678901234567890\n}');
    expect(compactJson(pretty)).toBe(compactJson(text));
  });

  it("keeps whitespace inside strings", () => {
    expect(compactJson('[ "a  b" ]')).toBe('["a  b"]');
  });

  it("keeps empty containers on one line and indents nested values", () => {
    expect(prettyJson('{"a":{},"b":[ ],"c":[1,{"d":null}]}')).toBe(
      '{\n  "a": {},\n  "b": [],\n  "c": [\n    1,\n    {\n      "d": null\n    }\n  ]\n}',
    );
  });

  it("handles escaped backslashes before a closing quote", () => {
    const text = '["a\\\\", "b\\\\\\"c" ]';
    expect(compactJson(text)).toBe('["a\\\\","b\\\\\\"c"]');
    expect(JSON.parse(prettyJson(text))).toEqual(JSON.parse(text));
  });
});

describe("splitJsonSequence", () => {
  it("splits multiple values", () => {
    expect(splitJsonSequence('"event"\n1\n{\n  "a": [1, 2]\n}\nnull')).toEqual(['"event"', "1", '{\n  "a": [1, 2]\n}', "null"]);
  });

  it("returns null for non-JSON output", () => {
    expect(splitJsonSequence("hello world")).toBeNull();
    expect(splitJsonSequence('{"a":')).toBeNull();
  });

  it("returns an empty list for empty output", () => {
    expect(splitJsonSequence("")).toEqual([]);
  });
});
