import { ParseErrorCode, visit } from "jsonc-parser";

export type JsonValidation = { ok: true; value: unknown } | { ok: false; message: string; offset: number };

const STRICT = { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false };

const STOP = Symbol("stop");

const ERROR_TEXT: Record<ParseErrorCode, string> = {
  [ParseErrorCode.InvalidSymbol]: "Unexpected character",
  [ParseErrorCode.InvalidNumberFormat]: "Invalid number",
  [ParseErrorCode.PropertyNameExpected]: "Expected a quoted property name",
  [ParseErrorCode.ValueExpected]: "Expected a value",
  [ParseErrorCode.ColonExpected]: "Expected a colon",
  [ParseErrorCode.CommaExpected]: "Expected a comma",
  [ParseErrorCode.CloseBraceExpected]: "Expected a closing brace",
  [ParseErrorCode.CloseBracketExpected]: "Expected a closing bracket",
  [ParseErrorCode.EndOfFileExpected]: "Unexpected text after the JSON value",
  [ParseErrorCode.InvalidCommentToken]: "Comments are not allowed",
  [ParseErrorCode.UnexpectedEndOfComment]: "Unclosed comment",
  [ParseErrorCode.UnexpectedEndOfString]: "Unclosed string",
  [ParseErrorCode.UnexpectedEndOfNumber]: "Incomplete number",
  [ParseErrorCode.InvalidUnicode]: "Invalid Unicode escape",
  [ParseErrorCode.InvalidEscapeCharacter]: "Invalid escape character",
  [ParseErrorCode.InvalidCharacter]: "Invalid character in string",
};

/** Native JSON.parse decides validity; the jsonc scanner runs only on failure to locate the error. */
export function validateJson(text: string): JsonValidation {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    let first: { error: ParseErrorCode; offset: number } | undefined;
    try {
      visit(
        text,
        {
          onError: (code, offset) => {
            first = { error: code, offset };
            throw STOP;
          },
        },
        STRICT,
      );
    } catch (stop) {
      if (stop !== STOP) throw stop;
    }
    if (first) return { ok: false, message: ERROR_TEXT[first.error], offset: first.offset };
    if (text.trim() === "") return { ok: false, message: "Empty message", offset: 0 };
    return { ok: false, message: error instanceof Error ? error.message : String(error), offset: 0 };
  }
}

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export function kindOf(value: unknown): JsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as JsonKind;
}

const QUOTE = 34;
const BACKSLASH = 92;

function isSpace(code: number): boolean {
  return code === 32 || code === 10 || code === 13 || code === 9;
}

/** Index just past the closing quote of the string starting at `start`. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  for (;;) {
    const close = text.indexOf('"', i);
    if (close === -1) return text.length;
    let slashes = 0;
    for (let j = close - 1; text.charCodeAt(j) === BACKSLASH; j--) slashes++;
    if (slashes % 2 === 0) return close + 1;
    i = close + 1;
  }
}

/** Removes insignificant whitespace only; input must be valid JSON. */
export function compactJson(text: string): string {
  const parts: string[] = [];
  let runStart = -1;
  const length = text.length;
  for (let i = 0; i < length; ) {
    const code = text.charCodeAt(i);
    if (isSpace(code)) {
      if (runStart !== -1) {
        parts.push(text.slice(runStart, i));
        runStart = -1;
      }
      i++;
      continue;
    }
    if (runStart === -1) runStart = i;
    i = code === QUOTE ? stringEnd(text, i) : i + 1;
  }
  if (runStart !== -1) parts.push(text.slice(runStart));
  return parts.length === 1 ? parts[0]! : parts.join("");
}

/** Re-indents with two spaces; only whitespace between tokens changes. Input must be valid JSON. */
export function prettyJson(text: string): string {
  const parts: string[] = [];
  const indents = ["\n"];
  const indent = (depth: number) => {
    while (indents.length <= depth) indents.push(indents[indents.length - 1] + "  ");
    return indents[depth]!;
  };
  let depth = 0;
  const length = text.length;
  let i = 0;
  const nextSignificant = (from: number) => {
    let j = from;
    while (j < length && isSpace(text.charCodeAt(j))) j++;
    return j;
  };
  while (i < length) {
    const code = text.charCodeAt(i);
    if (isSpace(code)) {
      i++;
      continue;
    }
    switch (code) {
      case 123:
      case 91: {
        const after = nextSignificant(i + 1);
        const closer = code === 123 ? 125 : 93;
        if (text.charCodeAt(after) === closer) {
          parts.push(code === 123 ? "{}" : "[]");
          i = after + 1;
        } else {
          depth++;
          parts.push(code === 123 ? "{" : "[", indent(depth));
          i++;
        }
        break;
      }
      case 125:
      case 93:
        depth--;
        parts.push(indent(depth), code === 125 ? "}" : "]");
        i++;
        break;
      case 44:
        parts.push(",", indent(depth));
        i++;
        break;
      case 58:
        parts.push(": ");
        i++;
        break;
      case QUOTE: {
        const end = stringEnd(text, i);
        parts.push(text.slice(i, end));
        i = end;
        break;
      }
      default: {
        let end = i + 1;
        while (end < length) {
          const c = text.charCodeAt(end);
          if (isSpace(c) || c === 44 || c === 93 || c === 125 || c === 58) break;
          end++;
        }
        parts.push(text.slice(i, end));
        i = end;
      }
    }
  }
  return parts.join("");
}

/**
 * Splits a sequence of JSON values (such as jq stdout) at top-level value boundaries.
 * Returns null unless every value is valid JSON and only whitespace separates them.
 */
export function splitJsonSequence(text: string): string[] | null {
  const values: string[] = [];
  const length = text.length;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < length; ) {
    const code = text.charCodeAt(i);
    if (isSpace(code)) {
      if (depth === 0 && start !== -1) {
        values.push(text.slice(start, i));
        start = -1;
      }
      i++;
      continue;
    }
    if (start === -1) start = i;
    if (code === QUOTE) {
      i = stringEnd(text, i);
    } else {
      if (code === 123 || code === 91) depth++;
      else if (code === 125 || code === 93) {
        depth--;
        if (depth < 0) return null;
      }
      i++;
    }
    if (depth === 0 && start !== -1 && (code === QUOTE || code === 125 || code === 93)) {
      values.push(text.slice(start, i));
      start = -1;
    }
  }
  if (start !== -1) values.push(text.slice(start));
  if (depth !== 0) return null;
  for (const value of values) if (!validateJson(value).ok) return null;
  return values;
}
