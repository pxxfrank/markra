/**
 * Browser-only harness for exercising the real CodeMirror table widget in a
 * real Chromium contenteditable. It deliberately uses the same extension set
 * as `packages/editor/src/codemirror/table.test.ts`, so the source text and
 * the rendered table stay observable from the test runner.
 */
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { liveMarkdown, tablePreviewPlugin } from "@markra/editor/codemirror";
import "@markra/app/styles.css";

const initialDoc = [
  "| Name | Value | Status |",
  "| --- | --- | --- |",
  "| Alpha | 1 | OK |",
  "| Beta | 2 | OK |",
  "",
  "After table",
].join("\n");

const parent = document.getElementById("editor")!;

const view = new EditorView({
  parent,
  state: EditorState.create({
    doc: initialDoc,
    extensions: [liveMarkdown({ plugins: [tablePreviewPlugin()] })],
    selection: EditorSelection.cursor(initialDoc.length),
  }),
});
view.focus();
view.dispatch({ selection: view.state.selection });

type CellKey = { row: number; column: number; header?: boolean };

function tableElement() {
  return document.querySelector<HTMLTableElement>(".cm-markra-table");
}

function cellElement(key: CellKey, tableIndex = 0) {
  const table = document.querySelectorAll<HTMLTableElement>(".cm-markra-table")[tableIndex];
  return table?.querySelector<HTMLTableCellElement>(
    `[data-table-row="${key.row}"][data-table-column="${key.column}"]` +
      `[data-table-header="${String(Boolean(key.header))}"]`,
  ) ?? null;
}

function placeCaret(cell: HTMLTableCellElement, offset: number) {
  cell.focus();
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let remaining = offset;
  while (node && remaining > (node.textContent?.length ?? 0)) {
    remaining -= node.textContent?.length ?? 0;
    node = walker.nextNode();
  }
  if (!node) {
    node = document.createTextNode("");
    cell.append(node);
  }
  const range = document.createRange();
  range.setStart(node, Math.min(remaining, node.textContent?.length ?? 0));
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function cells() {
  return [...document.querySelectorAll<HTMLTableCellElement>(".cm-markra-table th, .cm-markra-table td")].map(
    (cell) => ({
      row: cell.dataset.tableRow,
      column: cell.dataset.tableColumn,
      header: cell.dataset.tableHeader,
      text: cell.textContent,
    }),
  );
}

function snapshot() {
  const table = tableElement();
  const active = document.activeElement;
  const selection = window.getSelection();
  const activeCell = active instanceof HTMLTableCellElement ? active : null;
  const anchorCell = (() => {
    const node = selection?.anchorNode;
    const element = node instanceof Element ? node : node?.parentElement;
    return element?.closest<HTMLTableCellElement>("th, td") ?? null;
  })();
  const sample = document.querySelector<HTMLTableCellElement>(".cm-markra-table tbody td");
  const style = sample ? getComputedStyle(sample) : null;
  return {
    doc: view.state.doc.toString(),
    cells: cells(),
    tableFrom: document.querySelector<HTMLElement>(".cm-markra-table-wrap")?.dataset.tableFrom ?? null,
    tableConnected: Boolean(table?.isConnected),
    activeTag: active?.tagName ?? null,
    activeCellText: activeCell?.textContent ?? null,
    anchorCellText: anchorCell?.textContent ?? null,
    anchorCellConnected: anchorCell ? anchorCell.isConnected : null,
    selectionText: selection?.toString() ?? null,
    padding: style ? `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}` : null,
  };
}

function tableMetrics() {
  const table = tableElement();
  const scroll = table?.parentElement;
  const columns = [...(table?.querySelectorAll<HTMLTableColElement>(
    "colgroup[data-markra-table-column-widths] > col",
  ) ?? [])].map((column) => Number.parseFloat(column.style.width) || 0);
  return {
    mode: table?.dataset.widthMode ?? null,
    renderedWidth: table?.getBoundingClientRect().width ?? 0,
    inlineWidth: table?.style.getPropertyValue("width") ?? "",
    columns,
    cellWidths: [...(table?.querySelectorAll<HTMLTableCellElement>("thead th") ?? [])].map(
      (cell) => Math.round(cell.getBoundingClientRect().width * 100) / 100,
    ),
    scrollWidth: scroll?.scrollWidth ?? 0,
  };
}

function resizeColumn(column: number, deltaX: number) {
  const handle = document.querySelector<HTMLElement>(
    `.markra-table-column-resize[data-column="${column}"]`,
  );
  if (!handle) throw new Error(`resize handle not found: ${column}`);
  const rect = handle.getBoundingClientRect();
  const startX = Math.round(rect.left + rect.width / 2);
  handle.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: startX,
  }));
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: startX + deltaX }));
  window.dispatchEvent(new PointerEvent("pointerup", { clientX: startX + deltaX }));
}

function clearTableWidthPreferences() {
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith("markra:table-")) window.localStorage.removeItem(key);
  }
}

const api = {
  view,
  initialDoc,
  setDoc(text: string) {
    clearTableWidthPreferences();
    // Drop the current table widget first so each scenario starts from a fresh
    // DOM. Reusing an identical widget would keep the previous layout while
    // its saved widths were just cleared.
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "" },
    });
    view.dispatch({
      changes: { from: 0, insert: text },
      selection: { anchor: text.length },
    });
    view.focus();
    view.dispatch({ selection: view.state.selection });
  },
  getDoc: () => view.state.doc.toString(),
  focusCell(key: CellKey, offset = 0, tableIndex = 0) {
    const cell = cellElement(key, tableIndex);
    if (!cell) throw new Error(`cell not found: ${JSON.stringify(key)}`);
    placeCaret(cell, offset);
    return cell.textContent;
  },
  /** Synchronous, in-task typing. Mirrors a burst of browser-owned edits. */
  typeBurst(text: string) {
    for (const char of text) document.execCommand("insertText", false, char);
  },
  /** One CDP-style text insertion (a single input event). */
  insertText(text: string) {
    document.execCommand("insertText", false, text);
  },
  composition(text: string) {
    const table = tableElement()!;
    table.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    document.execCommand("insertText", false, text);
    table.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
  },
  backspace() {
    document.execCommand("delete", false);
  },
  setCssVariable(name: string, value: string) {
    (document.getElementById("paper") as HTMLElement).style.setProperty(name, value);
  },
  tableMetrics,
  resizeColumn,
  snapshot,
  async flush(frames = 2) {
    for (let index = 0; index < frames; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  },
};

(window as unknown as { __markra: typeof api }).__markra = api;
document.body.dataset.ready = "true";
