import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SidebarContext } from "./types.ts";
import { renderSidebar } from "./sidebar.ts";
import { dim } from "./colors.ts";

// No background by default so terminal transparency shows through.
// Set PI_SIDEBAR_BG="#rrggbb" to paint an opaque panel (hides scroll flash).
const SIDEBAR_BG = (() => {
  const hex = process.env["PI_SIDEBAR_BG"]?.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex ?? "")) return "";
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
})();
const BG_RESET = "\x1b[49m";

function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

function descriptorFor(obj: object, key: string): PropertyDescriptor | undefined {
  let target: object | null = obj;
  while (target) {
    const d = Object.getOwnPropertyDescriptor(target, key);
    if (d) return d;
    target = Object.getPrototypeOf(target);
  }
  return undefined;
}

export class SidebarCompositor {
  private tui: any;
  private terminal: any;
  private getCtx: () => SidebarContext;
  private originalColumnsDesc: PropertyDescriptor | undefined;
  private originalColumnsOwnDesc: PropertyDescriptor | undefined;
  private originalDoRender: ((...args: any[]) => any) | null = null;
  private originalWrite: (data: string) => void;
  private disposed = false;

  private readonly sidebarWidth: number;

  // Last painted sidebar content, used to repaint only rows that actually
  // changed. Prevents full-panel rewrites every frame (the flicker source).
  private cachedLines: string[] | null = null;
  private cachedColumns = 0;
  private cachedRows = 0;
  private cachedWidth = 0;
  private cacheValid = false;

  // Scroll offset for sidebar content when it overflows visible terminal rows.
  private scrollTop = 0;
  private maxScrollTop = 0;

  constructor(tui: any, getCtx: () => SidebarContext, sidebarWidth = 40) {
    this.tui = tui;
    this.terminal = tui.terminal;
    this.getCtx = getCtx;
    this.originalWrite = this.terminal.write.bind(this.terminal);
    this.sidebarWidth = sidebarWidth;
  }

  install(): void {
    // Narrow terminal.columns so pi renders in the left portion only.
    this.originalColumnsDesc = descriptorFor(this.terminal, "columns");
    this.originalColumnsOwnDesc = Object.getOwnPropertyDescriptor(this.terminal, "columns");
    const origDesc = this.originalColumnsDesc;
    const terminal = this.terminal;
    const self = this; // `this` inside the getter below is the terminal, not the compositor

    Object.defineProperty(terminal, "columns", {
      configurable: true,
      enumerable: true,
      get() {
        const d = origDesc;
        const raw = d?.get ? (d.get.call(terminal) ?? 80) : (typeof d?.value === "number" ? d.value : 80);
        return Math.max(1, raw - self.sidebarWidth - 1);
      },
    });

    // Paint sidebar after every pi render cycle.
    //
    // To stop flicker we merge the sidebar into pi's own render frame instead
    // of writing a separate frame afterwards:
    //   - wrap the whole doRender in a single synchronized-output block
    //     (?2026h ... ?2026l), stripping pi's own markers, so the main area and
    //     the sidebar update atomically (no gap where the sidebar is gone);
    //   - rewrite pi's full-line erase (\x1b[2K) into a width-limited erase
    //     (\x1b[<mainWidth>X) so pi's renders never wipe the sidebar columns.
    if (typeof this.tui.doRender === "function") {
      const originalDoRender = this.tui.doRender;
      this.originalDoRender = originalDoRender;
      const self = this;
      this.tui.doRender = function (...args: any[]) {
        if (self.disposed) return originalDoRender.apply(this, args);

        const writeOwnDesc = Object.getOwnPropertyDescriptor(terminal, "write");
        const originalWrite = terminal.write;
        const mainWidth = self.mainWidth();
        let forceFullPaint = false;
        let result: any;
        let didThrow = false;
        let thrown: unknown;

        self.originalWrite("\x1b[?2026h"); // begin synchronized output (single frame)
        try {
          Object.defineProperty(terminal, "write", {
            configurable: true,
            enumerable: true,
            writable: true,
            value(this: any, data: string) {
              if (typeof data !== "string") return originalWrite.call(this, data);
              if (/\x1b\[(?:2J|3J)|\n|\r\n|\x1b\[\d*[ST]|\x1bM/.test(data)) forceFullPaint = true;
              const sanitized = data
                .replace(/\x1b\[\?2026[hl]/g, "")
                .replace(/\x1b\[2K/g, `\x1b[${mainWidth}X`);
              return originalWrite.call(this, sanitized);
            },
          });

          try {
            result = originalDoRender.apply(this, args);
          } catch (error) {
            didThrow = true;
            thrown = error;
          }

          if (!didThrow) {
            try {
              self.paintInternal(forceFullPaint, false);
            } catch {
              // Sidebar painting must never break pi's render cycle.
            }
          }
        } finally {
          if (writeOwnDesc) {
            Object.defineProperty(terminal, "write", writeOwnDesc);
          } else {
            Reflect.deleteProperty(terminal, "write");
          }
          self.originalWrite("\x1b[?2026l"); // end synchronized output
        }

        if (didThrow) throw thrown;
        return result;
      };
    }
  }

  paint(): void {
    // Standalone paint (e.g. from a state-update request): its own sync frame.
    this.paintInternal(false, true);
  }

  // Maximum scroll offset: how many lines can be hidden above the viewport
  // before the last line reaches the bottom. 0 when content fits.
  private computeMaxScrollTop(): number {
    const rawRows = this.terminal.rows;
    const ctx = this.getCtx();
    const hasCwd = Boolean(ctx.cwd);
    const visiblePanelRows = hasCwd ? Math.max(1, rawRows - 1) : rawRows;
    const totalLines = renderSidebar(ctx, this.sidebarWidth).length;
    if (totalLines <= visiblePanelRows) return 0;
    const contentRowsAtBottom = Math.max(1, visiblePanelRows - 1);
    return Math.max(0, totalLines - contentRowsAtBottom);
  }

  getScrollTop(): number {
    return this.scrollTop;
  }

  getMaxScrollTop(): number {
    if (this.maxScrollTop === 0) {
      this.maxScrollTop = this.computeMaxScrollTop();
    }
    return this.maxScrollTop;
  }

  // Column where the sidebar's left border sits (1-based). Used by input
  // routing to decide whether the mouse is over the sidebar.
  getSeparatorColumn(): number {
    return this.rawColumns() - this.sidebarWidth;
  }

  scrollTo(top: number): void {
    if (this.maxScrollTop === 0) {
      this.maxScrollTop = this.computeMaxScrollTop();
    }
    const clamped = Math.max(0, Math.min(this.maxScrollTop, top));
    if (clamped !== this.scrollTop || !this.cacheValid) {
      this.scrollTop = clamped;
      this.cacheValid = false;
      this.paint();
    }
  }

  scrollBy(delta: number): void {
    this.scrollTo(this.scrollTop + delta);
  }

  scrollToTop(): void {
    this.scrollTo(0);
  }

  scrollToBottom(): void {
    if (this.maxScrollTop === 0) {
      this.maxScrollTop = this.computeMaxScrollTop();
    }
    this.scrollTo(this.maxScrollTop);
  }

  private rawColumns(): number {
    const d = this.originalColumnsDesc;
    const raw = d?.get
      ? d.get.call(this.terminal)
      : (typeof d?.value === "number" ? d.value : undefined);
    return typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 80;
  }

  // Width of pi's main area (columns left of the separator). Used to bound the
  // erase so the sidebar columns are never cleared.
  private mainWidth(): number {
    const rawCols = this.rawColumns();
    return Math.max(1, rawCols - this.sidebarWidth - 1);
  }

  private formatLine(line: string | undefined, width: number): string {
    const content = line === undefined ? "" : truncateToWidth(line, width, "", true);
    const padding = Math.max(0, width - visibleWidth(content));
    return `${SIDEBAR_BG}${content}${" ".repeat(padding)}${BG_RESET}`;
  }

  private paintInternal(forceFull: boolean, standalone: boolean): void {
    if (this.disposed) return;

    const rawRows = this.terminal.rows;
    const rawCols = this.rawColumns();
    const sw = this.sidebarWidth;
    const sepCol = rawCols - sw;
    const sidebarCol = sepCol + 1;

    const ctx = this.getCtx();
    const lines = renderSidebar(ctx, sw);
    const totalLines = lines.length;

    // Build the cwd bottom row (pinned to the last terminal row when present).
    const home = process.env["HOME"] ?? "";
    const cwd = ctx.cwd ?? "";
    const hasCwd = Boolean(cwd);
    const cwdDisplay = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
    const cwdTruncated = visibleWidth(cwdDisplay) > sw - 1
      ? "…" + cwdDisplay.slice(-(sw - 2))
      : cwdDisplay;
    const cwdLine = dim(" " + cwdTruncated);

    // Visible panel rows = all rows minus the pinned cwd row (when present).
    const visiblePanelRows = hasCwd ? Math.max(1, rawRows - 1) : rawRows;

    let panelLinesToRender: string[];

    if (totalLines <= visiblePanelRows) {
      // Content fits: no scrolling, no indicators.
      this.maxScrollTop = 0;
      this.scrollTop = 0;
      panelLinesToRender = [];
      for (let i = 0; i < visiblePanelRows; i++) {
        panelLinesToRender.push(lines[i] ?? "");
      }
    } else {
      // Content overflows visible rows. At the bottom, 1 row is reserved for
      // the top indicator, leaving (visiblePanelRows - 1) rows for content so
      // the exact last line is reachable. Hence maxScrollTop is constant.
      const contentRowsAtBottom = Math.max(1, visiblePanelRows - 1);
      this.maxScrollTop = Math.max(0, totalLines - contentRowsAtBottom);
      this.scrollTop = Math.max(0, Math.min(this.maxScrollTop, this.scrollTop));

      const isAtTop = this.scrollTop === 0;
      const isAtBottom = this.scrollTop >= this.maxScrollTop;

      panelLinesToRender = [];
      if (isAtTop) {
        // Top: no top indicator; last panel row is the bottom indicator.
        const contentRows = Math.max(1, visiblePanelRows - 1);
        for (let i = 0; i < contentRows; i++) panelLinesToRender.push(lines[i] ?? "");
        const linesBelow = Math.max(1, totalLines - contentRows);
        panelLinesToRender.push(dim(` ▼ ${linesBelow} line${linesBelow === 1 ? "" : "s"} below`));
      } else if (isAtBottom) {
        // Bottom: top indicator shown; no bottom indicator so the last line shows.
        panelLinesToRender.push(dim(` ▲ ${this.scrollTop} line${this.scrollTop === 1 ? "" : "s"} above`));
        const contentRows = Math.max(1, visiblePanelRows - 1);
        for (let i = 0; i < contentRows; i++) panelLinesToRender.push(lines[this.scrollTop + i] ?? "");
      } else {
        // Middle: both indicators shown.
        panelLinesToRender.push(dim(` ▲ ${this.scrollTop} line${this.scrollTop === 1 ? "" : "s"} above`));
        const contentRows = Math.max(1, visiblePanelRows - 2);
        for (let i = 0; i < contentRows; i++) panelLinesToRender.push(lines[this.scrollTop + i] ?? "");
        const linesBelow = Math.max(1, totalLines - (this.scrollTop + contentRows));
        panelLinesToRender.push(dim(` ▼ ${linesBelow} line${linesBelow === 1 ? "" : "s"} below`));
      }
      while (panelLinesToRender.length < visiblePanelRows) panelLinesToRender.push("");
    }

    const formattedLines: string[] = [];
    for (let i = 0; i < visiblePanelRows; i++) {
      formattedLines.push(this.formatLine(panelLinesToRender[i], sw));
    }
    if (hasCwd) {
      formattedLines.push(this.formatLine(cwdLine, sw));
    }

    // Repaint only rows that changed since the last paint. Skip the write
    // entirely when nothing changed — the core flicker fix.
    const dimensionsChanged = this.cachedColumns !== rawCols
      || this.cachedRows !== rawRows
      || this.cachedWidth !== sw;
    const shouldPaintAll = forceFull || !this.cacheValid || dimensionsChanged;
    const rows = shouldPaintAll
      ? formattedLines.map((_, index) => index)
      : formattedLines.reduce<number[]>((changed, line, index) => {
          if (this.cachedLines?.[index] !== line) changed.push(index);
          return changed;
        }, []);

    if (rows.length === 0) return;

    let buf = standalone ? "\x1b[?2026h" : "";
    buf += "\x1b7";          // save cursor (DECSC)
    buf += "\x1b[?7l";       // disable auto-wrap

    for (const index of rows) {
      const row = index + 1;
      buf += moveCursor(row, sepCol);
      buf += dim("│");
      buf += moveCursor(row, sidebarCol);
      buf += formattedLines[index];
    }

    buf += "\x1b[?7h";       // enable auto-wrap
    buf += "\x1b8";          // restore cursor (DECRC)
    if (standalone) buf += "\x1b[?2026l"; // end synchronized output

    try {
      this.originalWrite(buf);
    } catch {
      this.cacheValid = false;
      return;
    }

    this.cachedLines = formattedLines;
    this.cachedColumns = rawCols;
    this.cachedRows = rawRows;
    this.cachedWidth = sw;
    this.cacheValid = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.originalColumnsOwnDesc) {
      Object.defineProperty(this.terminal, "columns", this.originalColumnsOwnDesc);
    } else {
      Reflect.deleteProperty(this.terminal, "columns");
    }

    if (this.originalDoRender !== null) {
      this.tui.doRender = this.originalDoRender;
    }
  }
}
