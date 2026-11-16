/**
 * Chromium CDP runner for the Markra table widget.
 * No extra dependencies: Node 22 has a global WebSocket + fetch.
 *
 * Start the web dev server first:
 *   pnpm --filter @markra/web dev -- --host localhost --port 5173
 *
 * Usage:
 *   node apps/web/e2e/run.mjs [reportPath]
 *
 * Optional environment variables:
 *   MARKRA_CHROME_PATH  Chrome/Edge executable
 *   MARKRA_E2E_URL      Harness page URL
 *   MARKRA_E2E_PORT     DevTools port (default 9222)
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromeCandidates = [
  process.env.MARKRA_CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean);
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chromePath) {
  throw new Error("No Chromium browser found. Set MARKRA_CHROME_PATH to a Chrome/Edge executable.");
}

const port = Number(process.env.MARKRA_E2E_PORT ?? 9222);
const pageUrl = process.env.MARKRA_E2E_URL ?? "http://localhost:5173/e2e/table.html";
const reportPath = process.argv[2] ?? ".workbuddy/e2e/report.json";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // The endpoint or page is not ready yet.
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const userDataDir = mkdtempSync(join(tmpdir(), "markra-e2e-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--window-size=1280,900",
  "about:blank",
], { stdio: "ignore" });

function stopChrome() {
  if (process.platform === "win32") {
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
  } else {
    chrome.kill("SIGTERM");
  }
}

let socket;
try {
  try {
    const response = await fetch(pageUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    throw new Error(`Harness page is not reachable at ${pageUrl}. Start it with: pnpm --filter @markra/web dev -- --host localhost --port 5173`);
  }

  await waitFor(
    () => fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok),
    "Chrome DevTools endpoint",
  );

  const target = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(pageUrl)}`,
    { method: "PUT" },
  ).then((response) => response.json());

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let messageId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    handler(message);
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++messageId;
      pending.set(id, (message) => {
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description ?? detail.text);
    }
    return result.result.value;
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await waitFor(
    () => evaluate("document.body.dataset.ready === 'true' && Boolean(window.__markra?.snapshot)"),
    "table harness page",
    60000,
  );

  const scenarios = [
    {
      name: "initial-render",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush();
        const s = m.snapshot();
        return { doc: s.doc, cellCount: s.cells.length, tableFrom: s.tableFrom,
          padding: s.padding, ok: s.doc === m.initialDoc && s.cells.length === 9 && s.tableConnected };
      })()`,
    },
    {
      name: "paced-typing-in-body-cell",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush();
        m.focusCell({row:0,column:0}, 5);
        for (const char of "XYZ") { m.insertText(char); await m.flush(); }
        await m.flush(3);
        const s = m.snapshot();
        return { doc: s.doc, cellText: s.cells.find(c=>c.row==="0"&&c.column==="0"&&c.header==="false")?.text,
          activeCellText: s.activeCellText, ok: s.doc.includes("| AlphaXYZ | 1 | OK |") };
      })()`,
    },
    {
      name: "fast-burst-typing-in-body-cell",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush();
        m.focusCell({row:0,column:0}, 5);
        m.typeBurst("XYZ");
        await m.flush(3);
        const s = m.snapshot();
        return { doc: s.doc, cellText: s.cells.find(c=>c.row==="0"&&c.column==="0"&&c.header==="false")?.text,
          activeCellText: s.activeCellText, anchorCellConnected: s.anchorCellConnected,
          ok: s.doc.includes("| AlphaXYZ | 1 | OK |") };
      })()`,
    },
    {
      name: "fast-burst-typing-in-header",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush();
        m.focusCell({row:-1,column:1,header:true}, 5);
        m.typeBurst("ABC");
        await m.flush(3);
        const s = m.snapshot();
        return { doc: s.doc, headerText: s.cells.find(c=>c.header==="true"&&c.column==="1")?.text,
          ok: s.doc.includes("| Name | ValueABC | Status |") };
      })()`,
    },
    {
      name: "fast-burst-typing-in-empty-cell",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc("| A | B |\\n| --- | --- |\\n|  |  |");
        await m.flush();
        m.focusCell({row:0,column:0}, 0);
        m.typeBurst("hello");
        await m.flush(3);
        const s = m.snapshot();
        return { doc: s.doc, cellText: s.cells.find(c=>c.row==="0"&&c.column==="0"&&c.header==="false")?.text,
          ok: s.doc.includes("| hello |  |") };
      })()`,
    },
    {
      name: "ime-composition-chinese",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush();
        m.focusCell({row:0,column:0}, 5);
        m.composition("中文");
        await m.flush(3);
        const s = m.snapshot();
        return { doc: s.doc, cellText: s.cells.find(c=>c.row==="0"&&c.column==="0"&&c.header==="false")?.text,
          ok: s.doc.includes("| Alpha中文 | 1 | OK |") };
      })()`,
    },
    {
      name: "backspace-deletion",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush();
        m.focusCell({row:0,column:0}, 5);
        m.backspace();
        await m.flush(3);
        const s = m.snapshot();
        return { doc: s.doc, cellText: s.cells.find(c=>c.row==="0"&&c.column==="0"&&c.header==="false")?.text,
          ok: s.doc.includes("| Alph | 1 | OK |") };
      })()`,
    },
    {
      name: "edit-before-table-then-type",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc("Before\\n\\n" + m.initialDoc);
        await m.flush();
        m.view.dispatch({ changes: { from: 0, insert: "Expanded prefix. " }, selection: { anchor: 0 } });
        await m.flush();
        m.focusCell({row:0,column:0}, 5);
        m.typeBurst("QW");
        await m.flush(3);
        const s = m.snapshot();
        return { doc: s.doc, tableFrom: s.tableFrom,
          ok: s.doc.includes("| AlphaQW | 1 | OK |") && s.doc.startsWith("Expanded prefix. Before") };
      })()`,
    },
    {
      name: "tab-navigation-then-typing",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush();
        m.focusCell({row:0,column:0}, 5);
        const table = document.querySelector(".cm-markra-table");
        table.dispatchEvent(new KeyboardEvent("keydown", {key:"Tab", bubbles:true, cancelable:true}));
        await m.flush();
        m.typeBurst("Z");
        await m.flush(3);
        const s = m.snapshot();
        return { doc: s.doc, cells: s.cells.map(c=>c.text), activeCellText: s.activeCellText };
      })()`,
    },
    {
      name: "long-paste-burst",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush();
        m.focusCell({row:0,column:0}, 5);
        m.insertText("LongPastedValue123");
        await m.flush(3);
        const s = m.snapshot();
        return { doc: s.doc, ok: s.doc.includes("| AlphaLongPastedValue123 | 1 | OK |") };
      })()`,
    },
    {
      name: "multiple-tables-independent-typing",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc("| A | B |\\n| --- | --- |\\n| x | y |\\n\\nBetween\\n\\n| C | D |\\n| --- | --- |\\n| z | w |");
        await m.flush();
        m.focusCell({row:0,column:0}, 1, 0);
        m.typeBurst("12");
        await m.flush(3);
        m.focusCell({row:0,column:0}, 1, 1);
        m.typeBurst("34");
        await m.flush(3);
        const s = m.snapshot();
        return { doc: s.doc, ok: s.doc.includes("| x12 | y |") && s.doc.includes("| z34 | w |") };
      })()`,
    },
    {
      name: "structural-edit-then-typing",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush();
        document.querySelector('[aria-label="Add row below"]')?.click();
        await m.flush(2);
        m.focusCell({row:2,column:0}, 0);
        m.typeBurst("New");
        await m.flush(3);
        const s = m.snapshot();
        return { doc: s.doc, ok: s.doc.includes("| New |  |  |") };
      })()`,
    },
    {
      name: "inline-markdown-typing",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush();
        m.focusCell({row:0,column:0}, 5);
        m.typeBurst("**bold**");
        await m.flush(3);
        const s = m.snapshot();
        return { doc: s.doc, ok: s.doc.includes("| Alpha**bold** | 1 | OK |") };
      })()`,
    },
    {
      name: "spacing-does-not-break-typing",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        m.setCssVariable("--editor-table-cell-padding", "18px 24px");
        await m.flush();
        m.focusCell({row:0,column:0}, 5);
        m.typeBurst("PQ");
        await m.flush(3);
        const s = m.snapshot();
        m.setCssVariable("--editor-table-cell-padding", "8px 12px");
        return { doc: s.doc, padding: s.padding,
          ok: s.doc.includes("| AlphaPQ | 1 | OK |") && s.padding === "18px 24px 18px 24px" };
      })()`,
    },
    {
      name: "table-spacing-css-variable",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush();
        const before = m.snapshot().padding;
        m.setCssVariable("--editor-table-cell-padding", "20px 30px");
        await m.flush(1);
        const after = m.snapshot().padding;
        return { before, after, applied: before !== after,
          ok: before === "8px 12px 8px 12px" && after === "20px 30px 20px 30px" };
      })()`,
    },
    {
      name: "column-resize-drag",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        m.setCssVariable("--editor-table-cell-padding", "8px 12px");
        await m.flush(3);
        const before = m.tableMetrics();
        m.resizeColumn(0, 80);
        await m.flush(3);
        const after = m.tableMetrics();
        return { before, after, doc: m.getDoc(),
          ok: m.getDoc() === m.initialDoc &&
            before.mode !== "custom" &&
            after.mode === "custom" &&
            after.columns.length === 3 &&
            after.columns[0] > before.cellWidths[0] + 40 &&
            after.renderedWidth > before.renderedWidth + 40 &&
            after.inlineWidth !== "" };
      })()`,
    },
    {
      name: "column-resize-reset",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush(3);
        m.resizeColumn(0, 50);
        await m.flush(2);
        const resized = m.tableMetrics();
        document.querySelector(".markra-table-width-button")?.click();
        await m.flush(3);
        const reset = m.tableMetrics();
        return { resized, reset, doc: m.getDoc(),
          ok: resized.mode === "custom" && reset.mode !== "custom" &&
            reset.columns.length === 0 && reset.inlineWidth === "" &&
            m.getDoc() === m.initialDoc };
      })()`,
    },
    {
      name: "column-resize-survives-typing",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush(3);
        m.resizeColumn(1, 40);
        await m.flush(2);
        m.focusCell({ row: 0, column: 0 }, 5);
        m.typeBurst("Z");
        await m.flush(3);
        const metrics = m.tableMetrics();
        return { metrics, doc: m.getDoc(),
          ok: m.getDoc().includes("| AlphaZ | 1 | OK |") &&
            metrics.mode === "custom" && metrics.columns.length === 3 };
      })()`,
    },
    {
      name: "column-resize-survives-add-row",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush(3);
        m.resizeColumn(0, 30);
        await m.flush(2);
        const before = m.tableMetrics();
        document.querySelector('[aria-label="Add row below"]')?.click();
        await m.flush(4);
        const after = m.tableMetrics();
        return { before, after, doc: m.getDoc(),
          ok: before.mode === "custom" && after.mode === "custom" &&
            JSON.stringify(after.columns) === JSON.stringify(before.columns) &&
            m.getDoc().includes("|  |  |  |") };
      })()`,
    },
    {
      name: "column-resize-tracks-alignment",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush(3);
        m.resizeColumn(0, 30);
        await m.flush(2);
        document.querySelector('[aria-label="Align table center"]')?.click();
        await m.flush(4);
        const table = document.querySelector(".cm-markra-table");
        const metrics = m.tableMetrics();
        return { mode: metrics.mode, margin: table?.style.getPropertyValue("margin-inline"),
          alignment: table?.dataset.tableAlignment, doc: m.getDoc(),
          ok: metrics.mode === "custom" && metrics.columns.length === 3 &&
            table?.style.getPropertyValue("margin-inline") === "auto" &&
            table?.dataset.tableAlignment === "center" };
      })()`,
    },
    {
      name: "column-resize-from-even-mode",
      expression: `(async () => {
        const m = window.__markra;
        m.setDoc(m.initialDoc);
        await m.flush(3);
        const button = document.querySelector(".markra-table-width-button");
        button?.click();
        await m.flush(3);
        const before = m.tableMetrics();
        m.resizeColumn(2, -30);
        await m.flush(3);
        const after = m.tableMetrics();
        return { before, after, doc: m.getDoc(),
          ok: before.mode === "even" && after.mode === "custom" &&
            after.columns.length === 3 &&
            after.columns[2] < before.cellWidths[2] - 10 &&
            m.getDoc() === m.initialDoc };
      })()`,
    },
  ];

  const results = [];
  for (const scenario of scenarios) {
    try {
      const value = await evaluate(scenario.expression);
      results.push({ name: scenario.name, status: value?.ok === false ? "FAIL" : "PASS", value });
    } catch (error) {
      results.push({ name: scenario.name, status: "ERROR", error: String(error) });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    browser: "Chromium headless (CDP)",
    page: pageUrl,
    results,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  stopChrome();
}
