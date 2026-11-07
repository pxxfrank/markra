import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { liveMarkdown } from "./index.ts";
import { tablePreviewPlugin } from "./table.ts";
import "./dom.test-support.ts";

const views: EditorView[] = [];

function createView(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [liveMarkdown({ plugins: [tablePreviewPlugin()] })],
      selection: EditorSelection.cursor(doc.length),
    }),
  });
  view.focus();
  view.dispatch({ selection: view.state.selection });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  window.localStorage?.clear();
});

const source = "| Name | Value |\n| --- | --- |\n| Alpha | 1 |";

function placeCaret(cell: HTMLTableCellElement, offset: number) {
  cell.focus();
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  let remaining = offset;
  while (node && remaining > node.length) {
    remaining -= node.length;
    node = walker.nextNode() as Text | null;
  }
  if (!node) {
    node = document.createTextNode("");
    cell.append(node);
  }
  const range = document.createRange();
  range.setStart(node, Math.min(remaining, node.length));
  range.collapse(true);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function imeKeydown(table: HTMLTableElement, key: string) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  // Safari/WebKit reports IME-owned keys with the legacy 229 keyCode while
  // composition is being confirmed.
  Object.defineProperty(event, "keyCode", { value: 229 });
  table.dispatchEvent(event);
  return event;
}

function composition(table: HTMLTableElement, type: "start" | "end", data?: string) {
  table.dispatchEvent(
    new CompositionEvent(type === "start" ? "compositionstart" : "compositionend", {
      bubbles: true,
      data,
    }),
  );
}

function input(
  table: HTMLTableElement,
  data: string,
  inputType: string,
  isComposing: boolean,
) {
  table.dispatchEvent(
    new InputEvent("input", { bubbles: true, data, inputType, isComposing }),
  );
}

async function flushCompositionSync() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("visual table WebKit IME sequencing", () => {
  it("does not commit a partial composition before WebKit's commit input", async () => {
    const view = createView(source);
    const table = view.dom.querySelector<HTMLTableElement>(".cm-markra-table")!;
    const cell = table.querySelector<HTMLTableCellElement>("tbody td")!;

    placeCaret(cell, 5);
    composition(table, "start");

    // Pinyin buffer is inserted while the composition is still active.
    cell.textContent = "Alphazhongwen";
    placeCaret(cell, 13);
    input(table, "zhongwen", "insertCompositionText", true);

    // WebKit fires compositionend before the key/input that commits the text.
    composition(table, "end", "中文");
    expect(view.state.doc.toString()).toBe(source);

    imeKeydown(table, "Enter");
    expect(document.activeElement).toBe(cell);
    expect(cell.isConnected).toBe(true);

    cell.textContent = "Alpha中文";
    placeCaret(cell, 7);
    input(table, "中文", "insertFromComposition", false);
    await flushCompositionSync();

    expect(view.state.doc.toString()).toContain("| Alpha中文 | 1 |");
    expect(view.dom.querySelectorAll(".cm-markra-table tbody td")).toHaveLength(2);
  });

  it("keeps the composed text when WebKit commits without a table keydown", async () => {
    const view = createView(source);
    const table = view.dom.querySelector<HTMLTableElement>(".cm-markra-table")!;
    const cell = table.querySelector<HTMLTableCellElement>("tbody td")!;

    placeCaret(cell, 5);
    composition(table, "start");
    cell.textContent = "Alphasuda";
    placeCaret(cell, 9);
    input(table, "suda", "insertCompositionText", true);

    composition(table, "end", "苏打");
    expect(view.state.doc.toString()).toBe(source);

    cell.textContent = "Alpha苏打";
    placeCaret(cell, 7);
    input(table, "苏打", "insertFromComposition", false);
    await flushCompositionSync();

    expect(view.state.doc.toString()).toContain("| Alpha苏打 | 1 |");
    expect(view.dom.querySelector(".cm-markra-table")).not.toBeNull();
  });
});
