import { syntaxTree } from "@codemirror/language";
import { insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import {
  EditorSelection,
  EditorState,
  Prec,
  type ChangeSpec,
} from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

// A list item line that only carries its marker (and an optional task box).
const emptyListItemPattern = /^\s*(?:>\s*)*\s*(?:[-+*]|\d+[.)])(?:\s*\[[ xX]\])?\s*$/u;
const orderedMarkerPattern = /^(\s*(?:>\s*)*\s*)(\d+)([.)])/u;

function nextListItem(node: SyntaxNode) {
  let next = node.nextSibling;
  while (next && next.name !== "ListItem") next = next.nextSibling;
  return next;
}

// CodeMirror's default Markdown Enter command intentionally turns a tight
// list into a loose one when Enter is pressed on an empty second item: it
// inserts a blank line above that item. In a visual editor that reads as an
// unexplained blank row between two bullets. For a blank item that has a
// following item, remove the blank item line instead so the list stays tight;
// a blank last item still exits the list through the normal command.
function removeEmptyListItemLine(view: EditorView) {
  const state = view.state;
  if (state.facet(EditorState.readOnly)) return false;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (!range.empty) return false;
  const line = state.doc.lineAt(range.head);
  if (range.head !== line.to || line.number < 2) return false;
  if (!emptyListItemPattern.test(line.text)) return false;

  let item: SyntaxNode | null = syntaxTree(state).resolveInner(
    Math.max(line.from, line.to - 1),
    -1,
  );
  while (item && item.name !== "ListItem") item = item.parent;
  if (!item) return false;
  if (state.doc.lineAt(item.from).from !== line.from) return false;
  const following = nextListItem(item);
  // An empty item at the end of a list can also be followed by a blank line
  // and more content. Removing it there keeps a single separator blank line
  // instead of leaving an additional empty row behind.
  let blankLineThenContent = false;
  if (!following && line.number + 2 <= state.doc.lines) {
    if (state.doc.line(line.number + 1).text.trim().length === 0) {
      for (let number = line.number + 2; number <= state.doc.lines; number += 1) {
        if (state.doc.line(number).text.trim().length > 0) {
          blankLineThenContent = true;
          break;
        }
      }
    }
  }
  if (!following && !blankLineThenContent) return false;

  const lineBreakLength = state.lineBreak.length;
  const precedingBlank =
    state.doc.line(line.number - 1).text.trim().length === 0;
  // When a loose list already has a blank line above the empty item and a
  // blank line below it, drop the empty item together with the blank line
  // below it so the two separators collapse into one.
  const collapseLooseTail =
    !following && blankLineThenContent && precedingBlank;
  const changes: ChangeSpec[] = collapseLooseTail
    ? [{
        from: line.from,
        to: state.doc.line(line.number + 1).to + lineBreakLength,
      }]
    : [{ from: line.from - lineBreakLength, to: line.to }];
  if (item.parent?.name === "OrderedList") {
    const marker = orderedMarkerPattern.exec(line.text);
    let number = marker ? Number(marker[2]) : Number.NaN;
    let sibling: SyntaxNode | null = following;
    while (Number.isInteger(number) && sibling) {
      const siblingLine = state.doc.lineAt(sibling.from);
      const siblingMarker = orderedMarkerPattern.exec(siblingLine.text);
      if (!siblingMarker || Number(siblingMarker[2]) !== number + 1) break;
      const from = siblingLine.from + siblingMarker[1].length;
      changes.push({
        from,
        to: from + siblingMarker[2].length,
        insert: String(number),
      });
      number += 1;
      sibling = nextListItem(sibling);
    }
  }

  view.dispatch({
    changes,
    selection: EditorSelection.cursor(line.from - lineBreakLength, 1),
    scrollIntoView: true,
    userEvent: "input",
  });
  view.focus();
  return true;
}

function continueMarkdownBlock(view: EditorView) {
  if (removeEmptyListItemLine(view)) return true;
  return insertNewlineContinueMarkupCommand({ nonTightLists: false })(view);
}

// Runs before the language's own Enter binding. Everywhere else the command
// falls through to CodeMirror's Markdown continuation, so paragraphs, code
// blocks, quotes, and normal list items keep their native behavior.
export const markdownEnterKeymap = Prec.high(
  keymap.of([
    {
      key: "Enter",
      run: continueMarkdownBlock,
    },
  ]),
);
