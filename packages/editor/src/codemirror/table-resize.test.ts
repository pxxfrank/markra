import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { liveMarkdown } from "./index.ts";
import { tablePreviewPlugin } from "./table.ts";
import {
  readStoredTableColumnWidths,
  tableColumnWidthsStoragePrefix,
} from "./table-resize.ts";
import "./dom.test-support.ts";

const doc = [
  "| Name | Value | Status |",
  "| --- | --- | --- |",
  "| Alpha | 1 | OK |",
  "",
  "After table",
].join("\n");
const headerSources = ["Name", "Value", "Status"];
const secondTableHeaders = ["One", "Two", "Three"];
const views: EditorView[] = [];

function createView(
  documentKey: string | null = "notes.md",
  source: string = doc,
) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: source,
      extensions: [
        liveMarkdown({
          plugins: [
            tablePreviewPlugin({
              getDocumentKey: () => documentKey,
            }),
          ],
        }),
      ],
      selection: EditorSelection.cursor(source.length),
    }),
  });
  view.focus();
  view.dispatch({ selection: view.state.selection });
  views.push(view);
  return view;
}

function tableAt(view: EditorView, index = 0) {
  return view.dom.querySelectorAll<HTMLTableElement>(".cm-markra-table")[index]!;
}

function handle(view: EditorView, column = 0, tableIndex = 0) {
  return tableAt(view, tableIndex)
    .closest(".cm-markra-table-wrap")!
    .querySelector<HTMLElement>(
      `.markra-table-column-resize[data-column="${column}"]`,
    )!;
}

function columnWidths(view: EditorView, tableIndex = 0) {
  return Array.from(
    tableAt(view, tableIndex).querySelectorAll<HTMLColElement>(
      "colgroup[data-markra-table-column-widths] > col",
    ),
    (column) => column.style.width,
  );
}

function drag(
  view: EditorView,
  column: number,
  deltaX: number,
  tableIndex = 0,
) {
  const target = handle(view, column, tableIndex);
  target.dispatchEvent(new MouseEvent("pointerdown", {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: 100,
  }));
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 100 + deltaX }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 100 + deltaX }));
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  window.localStorage.clear();
});

describe("visual table column resizing", () => {
  it("renders a draggable separator for every column", () => {
    const view = createView();
    const handles = view.dom.querySelectorAll(".markra-table-column-resize");
    expect(handles).toHaveLength(3);
    for (const separator of handles) {
      expect(separator.getAttribute("role")).toBe("separator");
      expect(separator.getAttribute("aria-orientation")).toBe("vertical");
      expect(separator.getAttribute("aria-label")).toMatch(/Resize column \d/u);
    }
  });

  it("resizes one column by dragging and leaves the Markdown untouched", async () => {
    const view = createView();
    const before = view.state.doc.toString();

    drag(view, 0, 60);
    await Promise.resolve();

    expect(view.state.doc.toString()).toBe(before);
    expect(tableAt(view).dataset.widthMode).toBe("custom");
    expect(columnWidths(view)).toEqual(["160px", "100px", "100px"]);
    expect(tableAt(view).style.getPropertyValue("width")).toBe("360px");
    expect(tableAt(view).style.getPropertyPriority("width")).toBe("important");
    expect(
      view.dom.querySelector<HTMLButtonElement>(".markra-table-width-button")
        ?.dataset.mode,
    ).toBe("custom");
    expect(
      readStoredTableColumnWidths(document, "notes.md", headerSources, 3),
    ).toEqual([160, 100, 100]);
  });

  it("persists column widths across editor recreation", async () => {
    const first = createView();
    drag(first, 1, 30);
    await Promise.resolve();
    expect(
      readStoredTableColumnWidths(document, "notes.md", headerSources, 3),
    ).toEqual([100, 130, 100]);
    first.destroy();
    views.splice(views.indexOf(first), 1);

    const second = createView();
    expect(tableAt(second).dataset.widthMode).toBe("custom");
    expect(columnWidths(second)).toEqual(["100px", "130px", "100px"]);
    expect(tableAt(second).style.getPropertyValue("width")).toBe("330px");
  });

  it("resizes a column with the keyboard", async () => {
    const view = createView();
    handle(view, 2).dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
      shiftKey: true,
    }));
    await Promise.resolve();

    expect(columnWidths(view)).toEqual(["100px", "100px", "150px"]);
    expect(
      readStoredTableColumnWidths(document, "notes.md", headerSources, 3),
    ).toEqual([100, 100, 150]);
  });

  it("resets the current table to the document width mode from the toolbar", async () => {
    const view = createView();
    drag(view, 0, 40);
    await Promise.resolve();
    expect(columnWidths(view)).toHaveLength(3);

    view.dom.querySelector<HTMLButtonElement>(".markra-table-width-button")!.click();
    await Promise.resolve();

    expect(view.dom.querySelector("colgroup")).toBeNull();
    expect(tableAt(view).dataset.widthMode).toBe("auto");
    expect(tableAt(view).style.getPropertyValue("width")).toBe("");
    expect(
      readStoredTableColumnWidths(document, "notes.md", headerSources, 3),
    ).toBeNull();
    for (let index = 0; index < window.localStorage.length; index += 1) {
      expect(window.localStorage.key(index)).not.toContain(
        tableColumnWidthsStoragePrefix,
      );
    }
  });

  it("keeps another table's custom widths when one table leaves custom mode", async () => {
    const source = [
      "| Name | Value | Status |",
      "| --- | --- | --- |",
      "| Alpha | 1 | OK |",
      "",
      "| One | Two | Three |",
      "| --- | --- | --- |",
      "| A | B | C |",
    ].join("\n");
    const view = createView("notes.md", source);
    drag(view, 0, 20, 0);
    await Promise.resolve();
    drag(view, 0, 30, 1);
    await Promise.resolve();

    expect(columnWidths(view, 0)).toEqual(["120px", "100px", "100px"]);
    expect(columnWidths(view, 1)).toEqual(["130px", "100px", "100px"]);
    expect(
      readStoredTableColumnWidths(document, "notes.md", headerSources, 3),
    ).toEqual([120, 100, 100]);
    expect(
      readStoredTableColumnWidths(document, "notes.md", secondTableHeaders, 3),
    ).toEqual([130, 100, 100]);

    view.dom
      .querySelectorAll<HTMLButtonElement>(".markra-table-width-button")[0]!
      .click();
    await Promise.resolve();

    expect(tableAt(view, 0).dataset.widthMode).toBe("auto");
    expect(tableAt(view, 0).querySelector("colgroup")).toBeNull();
    expect(
      readStoredTableColumnWidths(document, "notes.md", headerSources, 3),
    ).toBeNull();
    expect(tableAt(view, 1).dataset.widthMode).toBe("custom");
    expect(columnWidths(view, 1)).toEqual(["130px", "100px", "100px"]);
    expect(
      readStoredTableColumnWidths(document, "notes.md", secondTableHeaders, 3),
    ).toEqual([130, 100, 100]);
  });

  it("cancels a drag on Escape and restores the previous layout", async () => {
    const view = createView();
    const target = handle(view, 0);

    target.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: 100,
    }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 180 }));
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 180 }));
    await Promise.resolve();

    expect(view.state.doc.toString()).toBe(doc);
    expect(tableAt(view).dataset.widthMode).toBe("auto");
    expect(view.dom.querySelector("colgroup")).toBeNull();
    expect(
      readStoredTableColumnWidths(document, "notes.md", headerSources, 3),
    ).toBeNull();
  });
});
