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
  window.localStorage.clear();
});

const source = "| Name | Value |\n| --- | --- |\n| Alpha | 1 |";

/** Mimics browser-owned text insertion into the shared contenteditable host. */
function typeInto(cell: HTMLTableCellElement, table: HTMLTableElement, text: string) {
  for (const char of text) {
    cell.textContent = `${cell.textContent ?? ""}${char}`;
    table.dispatchEvent(new InputEvent("input", { bubbles: true, data: char }));
  }
}

describe("table input host stability", () => {
  it("keeps the same editing host mounted for a burst of keystrokes", async () => {
    const view = createView(source);
    const table = view.dom.querySelector<HTMLTableElement>(".cm-markra-table")!;
    const cell = view.dom.querySelector<HTMLTableCellElement>(
      ".cm-markra-table tbody td",
    )!;
    cell.focus();

    typeInto(cell, table, "XYZ");
    await Promise.resolve();

    expect(view.state.doc.toString()).toBe(source.replace("Alpha", "AlphaXYZ"));
    // Recreating the contenteditable table mid-burst drops the browser-owned
    // selection, so the remaining characters land in the Markdown source.
    expect(view.dom.querySelector(".cm-markra-table")).toBe(table);
    expect(view.dom.querySelector(".cm-markra-table tbody td")).toBe(cell);
    expect(cell.textContent).toBe("AlphaXYZ");
  });

  it("repaints reused cells after an external source transaction", async () => {
    const view = createView(source);
    const table = view.dom.querySelector<HTMLTableElement>(".cm-markra-table")!;
    const cell = view.dom.querySelector<HTMLTableCellElement>(
      ".cm-markra-table tbody td",
    )!;
    const from = source.indexOf("Alpha");

    view.dispatch({ changes: { from, to: from + "Alpha".length, insert: "Changed" } });
    await Promise.resolve();

    expect(view.dom.querySelector(".cm-markra-table")).toBe(table);
    expect(cell.textContent).toBe("Changed");
    expect(view.state.doc.toString()).toBe(source.replace("Alpha", "Changed"));
  });

  it("keeps typing at the current range after text before the table changes", async () => {
    const doc = `Before\n\n${source}`;
    const view = createView(doc);
    const table = view.dom.querySelector<HTMLTableElement>(".cm-markra-table")!;
    const cell = view.dom.querySelector<HTMLTableCellElement>(
      ".cm-markra-table tbody td",
    )!;

    view.dispatch({ changes: { from: 0, insert: "Prefix " } });
    await Promise.resolve();
    expect(view.dom.querySelector(".cm-markra-table")).toBe(table);

    cell.focus();
    typeInto(cell, table, "QW");
    await Promise.resolve();

    expect(view.state.doc.toString()).toBe(
      `Prefix Before\n\n${source.replace("Alpha", "AlphaQW")}`,
    );
    expect(view.dom.querySelector(".cm-markra-table")).toBe(table);
  });

  it("still rebuilds the host when rows are added", async () => {
    const view = createView(source);
    const table = view.dom.querySelector<HTMLTableElement>(".cm-markra-table")!;

    view.dom
      .querySelector<HTMLButtonElement>('[aria-label="Add row below"]')
      ?.click();
    await Promise.resolve();

    expect(view.dom.querySelector(".cm-markra-table")).not.toBe(table);
    expect(view.dom.querySelectorAll(".cm-markra-table tbody tr")).toHaveLength(2);
    expect(view.state.doc.toString()).toContain("|  |  |");
  });
});
