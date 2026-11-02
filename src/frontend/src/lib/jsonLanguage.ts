import { HighlightStyle, Language, defineLanguageFacet, languageDataProp, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { NodeType, Parser, Tree, type Input, type PartialParse, type TreeFragment } from "@lezer/common";
import { tags } from "@lezer/highlight";
import { parser as jsonParser } from "@lezer/json";

const facet = defineLanguageFacet();
const documentType = NodeType.define({ id: 0, name: "Document", top: true, props: [[languageDataProp, facet]] });

/** Parses the document text from `from` onward, so a protocol prefix stays unstyled. */
class SuffixParser extends Parser {
  constructor(private readonly from: number) {
    super();
  }

  createParse(input: Input, _fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
    const to = ranges[ranges.length - 1]!.to;
    const from = Math.min(this.from, to);
    // Lezer positions a ranged parse relative to the range start; mount it at `from`.
    const inner = jsonParser.createParse(input, [], [{ from, to }]);
    return {
      advance: () => {
        const tree = inner.advance();
        return tree && new Tree(documentType, [tree], [from], to);
      },
      get parsedPos() {
        return inner.parsedPos;
      },
      stopAt: (pos) => inner.stopAt(pos),
      get stoppedAt() {
        return inner.stoppedAt;
      },
    };
  }
}

const style = HighlightStyle.define([
  { tag: tags.propertyName, color: "#fec418" },
  { tag: tags.string, color: "#48b685" },
  { tag: tags.number, color: "#b5cea8" },
  { tag: [tags.bool, tags.null], color: "#d2a8ff" },
  { tag: [tags.brace, tags.squareBracket, tags.separator, tags.punctuation], color: "rgb(255 255 255 / 0.6)" },
]);

/** Highlights JSON that starts at document offset `from`. */
export function jsonHighlight(from: number): Extension {
  return [new Language(facet, new SuffixParser(from), [], "json").extension, syntaxHighlighting(style)];
}
