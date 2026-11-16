import type { EditorView } from "@codemirror/view";
import type { TableWidthModeState } from "./table-controls.ts";

export type TableColumnAlignment = "center" | "left" | "right" | null;

const columnWidthsStoragePrefix = "markra:table-column-widths";
const minimumColumnWidth = 48;
const maximumColumnWidth = 2000;
const customLayoutProperties = [
  "width",
  "min-width",
  "max-width",
  "table-layout",
  "margin-inline",
] as const;

export const tableColumnWidthsStoragePrefix = columnWidthsStoragePrefix;

function boundedTableColumnWidth(width: number) {
  return Math.min(maximumColumnWidth, Math.max(minimumColumnWidth, Math.round(width)));
}

function storageFor(document: Document) {
  try {
    return document.defaultView?.localStorage ?? null;
  } catch {
    return null;
  }
}

function normalizedDocumentKey(documentKey: string | null | undefined) {
  return documentKey?.trim() || "untitled";
}

// FNV-1a keeps the header signature compact; the column count is stored in the
// key as well so a structural change cannot apply stale widths.
function signatureHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function columnWidthsStorageKey(
  documentKey: string | null | undefined,
  headerSources: readonly string[],
  columnCount: number,
) {
  return `${columnWidthsStoragePrefix}:${encodeURIComponent(normalizedDocumentKey(documentKey))}` +
    `:${columnCount}:${signatureHash(headerSources.join("\u0001"))}`;
}

function parsedWidths(raw: string, columnCount: number) {
  try {
    const value = JSON.parse(raw) as { columns?: unknown; widths?: unknown };
    if (
      value.columns !== columnCount ||
      !Array.isArray(value.widths) ||
      value.widths.length !== columnCount
    ) {
      return null;
    }
    const widths = value.widths.map((width) => Number(width));
    return widths.every((width) => Number.isFinite(width))
      ? widths.map(boundedTableColumnWidth)
      : null;
  } catch {
    return null;
  }
}

export function readStoredTableColumnWidths(
  document: Document,
  documentKey: string | null | undefined,
  headerSources: readonly string[],
  columnCount: number,
) {
  const storage = storageFor(document);
  if (!storage) return null;
  const key = columnWidthsStorageKey(documentKey, headerSources, columnCount);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const widths = parsedWidths(raw, columnCount);
    if (!widths) {
      storage.removeItem(key);
      return null;
    }
    return widths;
  } catch {
    return null;
  }
}

export function writeStoredTableColumnWidths(
  document: Document,
  documentKey: string | null | undefined,
  headerSources: readonly string[],
  widths: readonly number[],
) {
  const storage = storageFor(document);
  if (!storage) return;
  try {
    storage.setItem(
      columnWidthsStorageKey(documentKey, headerSources, widths.length),
      JSON.stringify({
        columns: widths.length,
        widths: widths.map(boundedTableColumnWidth),
      }),
    );
  } catch {
    // A full or disabled localStorage must not break table editing.
  }
}

export function clearStoredTableColumnWidths(
  document: Document,
  documentKey: string | null | undefined,
  headerSources: readonly string[],
  columnCount: number,
) {
  const storage = storageFor(document);
  if (!storage) return;
  try {
    storage.removeItem(columnWidthsStorageKey(documentKey, headerSources, columnCount));
  } catch {
    // Ignore storage failures.
  }
}

function columnWidthsColgroup(table: HTMLTableElement) {
  for (const child of Array.from(table.children)) {
    if (
      child.tagName === "COLGROUP" &&
      (child as HTMLElement).dataset.markraTableColumnWidths === "true"
    ) {
      return child as HTMLTableColElement;
    }
  }
  return null;
}

function alignmentMargin(alignment: TableColumnAlignment) {
  if (alignment === "center") return "auto";
  if (alignment === "right") return "auto 0px";
  return "0px auto";
}

export function syncTableColumnWidthsAlignment(
  table: HTMLTableElement,
  alignment: TableColumnAlignment,
) {
  if (!columnWidthsColgroup(table)) return;
  table.style.setProperty("margin-inline", alignmentMargin(alignment), "important");
}

export function applyTableColumnWidths(
  table: HTMLTableElement,
  widths: readonly number[],
  alignment: TableColumnAlignment,
) {
  if (!widths.length) return 0;
  const bounded = widths.map(boundedTableColumnWidth);
  const total = bounded.reduce((sum, width) => sum + width, 0);
  let group = columnWidthsColgroup(table);
  if (!group) {
    group = table.ownerDocument.createElement("colgroup");
    (group as HTMLElement).dataset.markraTableColumnWidths = "true";
    table.insertBefore(group, table.firstChild);
  }
  group.replaceChildren(
    ...bounded.map((width) => {
      const column = table.ownerDocument.createElement("col");
      column.style.width = `${width}px`;
      return column;
    }),
  );
  // The app stylesheet pins Markdown tables to the available width with
  // `!important`, so an inline `!important` declaration is required to let a
  // user-chosen table width win.
  table.style.setProperty("width", `${total}px`, "important");
  table.style.setProperty("min-width", "0px", "important");
  table.style.setProperty("max-width", "none", "important");
  table.style.setProperty("table-layout", "fixed", "important");
  table.style.setProperty("margin-inline", alignmentMargin(alignment), "important");
  return total;
}

export function clearTableColumnWidthsLayout(table: HTMLTableElement) {
  columnWidthsColgroup(table)?.remove();
  for (const property of customLayoutProperties) {
    table.style.removeProperty(property);
  }
}

function measureTableColumnWidths(
  table: HTMLTableElement,
  columnCount: number,
) {
  const tableRect = table.getBoundingClientRect();
  const headerCells = Array.from(table.tHead?.rows[0]?.cells ?? []);
  const fallback = tableRect.width > 0 ? tableRect.width / columnCount : 100;
  let left = tableRect.left;
  const widths: number[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    const rect = headerCells[column]?.getBoundingClientRect();
    const right = rect && rect.width > 0
      ? rect.right
      : left + fallback;
    widths.push(boundedTableColumnWidth(right - left));
    left = right;
  }
  return widths;
}

export interface TableColumnResizeOptions {
  view: EditorView;
  scroll: HTMLElement;
  table: HTMLTableElement;
  label: string;
  columnCount: number;
  readOnly: () => boolean;
  alignment: () => TableColumnAlignment;
  currentMode: () => TableWidthModeState;
  fallbackMode: () => "auto" | "even";
  onModeChange: (mode: TableWidthModeState) => unknown;
  persist: (widths: readonly number[]) => unknown;
  clearStored: () => unknown;
}

export interface TableColumnResizers {
  destroy(): void;
  measure(): void;
}

export function attachTableColumnResizers(
  options: TableColumnResizeOptions,
): TableColumnResizers {
  const { view, scroll, table, columnCount } = options;
  const document = table.ownerDocument;
  const window = document.defaultView;
  const handles: HTMLElement[] = [];
  const guide = document.createElement("div");
  guide.className = "markra-table-column-guide";
  guide.hidden = true;
  scroll.append(guide);
  let destroyed = false;
  let cancelDrag: (() => unknown) | null = null;
  let draggingColumn: number | null = null;

  const requestEditorMeasure = () => {
    if (table.isConnected) view.requestMeasure();
  };

  const measure = () => {
    if (destroyed || !table.isConnected) return;
    view.requestMeasure({
      key: scroll,
      read: () => {
        const tableRect = table.getBoundingClientRect();
        const scrollRect = scroll.getBoundingClientRect();
        const header = table.tHead?.rows[0] ?? null;
        const headerRect = header?.getBoundingClientRect() ?? null;
        const cells = Array.from(header?.cells ?? []);
        return {
          boundaries: cells.map(
            (cell) => cell.getBoundingClientRect().right - scrollRect.left + scroll.scrollLeft,
          ),
          headerHeight: headerRect?.height ?? 0,
          headerTop: headerRect
            ? headerRect.top - scrollRect.top + scroll.scrollTop
            : 0,
          tableHeight: tableRect.height,
        };
      },
      write: (measurement) => {
        if (destroyed) return;
        let previousBoundary = 0;
        handles.forEach((handle, index) => {
          const boundary = measurement.boundaries[index] ?? previousBoundary;
          handle.setAttribute(
            "aria-valuenow",
            String(Math.max(1, Math.round(boundary - previousBoundary))),
          );
          previousBoundary = boundary;
          handle.style.left = `${boundary}px`;
          handle.style.top = `${measurement.headerTop}px`;
          handle.style.height = `${Math.max(20, measurement.headerHeight)}px`;
        });
        if (draggingColumn !== null) {
          guide.hidden = false;
          guide.style.left = `${measurement.boundaries[draggingColumn] ?? 0}px`;
          guide.style.top = `${measurement.headerTop}px`;
          guide.style.height = `${measurement.tableHeight}px`;
        } else {
          guide.hidden = true;
        }
      },
    });
  };

  const applyWidths = (widths: readonly number[]) => {
    applyTableColumnWidths(table, widths, options.alignment());
    options.onModeChange("custom");
    measure();
    requestEditorMeasure();
  };

  const restoreMode = (mode: TableWidthModeState, widths: readonly number[]) => {
    if (mode === "custom") {
      applyWidths(widths);
      return;
    }
    clearTableColumnWidthsLayout(table);
    options.onModeChange(mode);
    measure();
    requestEditorMeasure();
  };

  for (let column = 0; column < columnCount; column += 1) {
    const handle = document.createElement("div");
    handle.className = "markra-table-column-resize";
    handle.dataset.column = String(column);
    if (column === columnCount - 1) handle.dataset.last = "true";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", `${options.label} ${column + 1}`);
    handle.title = `${options.label} ${column + 1}`;
    handle.setAttribute("aria-valuemin", String(minimumColumnWidth));
    handle.setAttribute("aria-valuemax", String(maximumColumnWidth));
    handle.setAttribute("aria-valuenow", "100");
    if (options.readOnly()) handle.hidden = true;
    handle.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      // Keep the cell caret where it is; the handle is not part of the
      // contenteditable table.
      event.preventDefault();
      event.stopPropagation();
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || options.readOnly()) return;
      event.preventDefault();
      event.stopPropagation();
      cancelDrag?.();
      const initial = measureTableColumnWidths(table, columnCount);
      const previousMode = options.currentMode();
      const initialX = event.clientX;
      let next = initial;
      draggingColumn = column;
      handle.dataset.active = "true";
      const bodyStyle = document.body?.style;
      const previousCursor = bodyStyle?.cursor ?? "";
      const previousUserSelect = bodyStyle?.userSelect ?? "";
      if (bodyStyle) {
        bodyStyle.cursor = "col-resize";
        bodyStyle.userSelect = "none";
      }
      applyWidths(initial);

      const restore = () => {
        window?.removeEventListener("pointermove", move);
        window?.removeEventListener("pointerup", finish);
        window?.removeEventListener("pointercancel", cancel);
        window?.removeEventListener("blur", cancel);
        window?.removeEventListener("keydown", key, true);
        draggingColumn = null;
        delete handle.dataset.active;
        guide.hidden = true;
        cancelDrag = null;
        if (bodyStyle) {
          bodyStyle.cursor = previousCursor;
          bodyStyle.userSelect = previousUserSelect;
        }
      };
      const move = (moveEvent: PointerEvent) => {
        if (options.readOnly()) {
          cancel();
          return;
        }
        next = [...initial];
        next[column] = boundedTableColumnWidth(
          initial[column]! + moveEvent.clientX - initialX,
        );
        applyWidths(next);
      };
      const finish = () => {
        const changed = next.some((width, index) => width !== initial[index]);
        restore();
        if (changed) {
          options.persist(next);
          applyWidths(next);
        } else {
          restoreMode(previousMode, initial);
        }
      };
      const cancel = () => {
        restore();
        restoreMode(previousMode, initial);
      };
      const key = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== "Escape") return;
        // Capture phase: Escape must cancel the resize without also leaving
        // the table cell that owned the caret before the drag.
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        cancel();
      };
      cancelDrag = cancel;
      window?.addEventListener("pointermove", move);
      window?.addEventListener("pointerup", finish);
      window?.addEventListener("pointercancel", cancel);
      window?.addEventListener("blur", cancel);
      window?.addEventListener("keydown", key, true);
    });
    handle.addEventListener("keydown", (event) => {
      if (
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
        options.readOnly()
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const widths = measureTableColumnWidths(table, columnCount);
      widths[column] = boundedTableColumnWidth(
        widths[column]! + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 50 : 10),
      );
      options.persist(widths);
      applyWidths(widths);
    });
    handle.addEventListener("dblclick", (event) => {
      if (options.readOnly()) return;
      event.preventDefault();
      event.stopPropagation();
      options.clearStored();
      restoreMode(options.fallbackMode(), measureTableColumnWidths(table, columnCount));
    });
    scroll.append(handle);
    handles.push(handle);
  }

  const observer =
    typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;
  observer?.observe(table);
  measure();

  return {
    destroy() {
      destroyed = true;
      cancelDrag?.();
      observer?.disconnect();
      for (const handle of handles) handle.remove();
      guide.remove();
    },
    measure,
  };
}
