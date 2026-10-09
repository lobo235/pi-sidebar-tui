import test from "node:test";
import assert from "node:assert/strict";
import { SidebarCompositor } from "../compositor.ts";
import type { SidebarContext } from "../types.ts";

function makeCtx(overrides: Partial<SidebarContext> = {}): SidebarContext {
  return {
    sessionTitle: null,
    sessionId: null,
    todos: [],
    branch: "main",
    aheadCount: 0,
    untrackedCount: 0,
    workspaceFiles: [],
    cwd: "/tmp/test",
    model: null,
    thinkingLevel: null,
    contextTokens: null,
    contextPercent: null,
    contextWindow: null,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    sessionCost: 0,
    turnCount: 0,
    activeTool: null,
    autoCompactEnabled: null,
    sessionStartMs: Date.now(),
    mcpServers: [],
    modelProvider: null,
    liveTps: null,
    lastTps: null,
    lastTurnMs: null,
    ctxSamples: [],
    ...overrides,
  };
}

// 30 todos (todosMax 100) + a branch-less workspace => the last line of the
// whole sidebar is the workspace "(not a git repo)" row. Total lines far
// exceed a 15-row terminal, so the content overflows.
function tallCtx(tick = 0): SidebarContext {
  const todos = Array.from({ length: 30 }, (_, i) => ({
    id: String(i + 1),
    content: i === 0 ? `line one (tick ${tick})` : `todo number ${i + 1}`,
    status: "pending" as const,
  }));
  return makeCtx({ todos, todosMax: 100, branch: null, workspaceFiles: [] });
}

function makeTerminal(cols: number, rows: number) {
  return {
    columns: cols,
    rows,
    writes: [] as string[],
    write(data: string) {
      this.writes.push(data);
    },
  };
}

function makeComp(getCtx: () => SidebarContext, rows: number, width: number, cols = 80) {
  const terminal = makeTerminal(cols, rows);
  const tui: any = { terminal, mode: "fullscreen", doRender() {} };
  const comp = new SidebarCompositor(tui, getCtx, width);
  comp.install();
  return { comp, terminal };
}

test("scroll state: no overflow => maxScrollTop 0 and scroll stays clamped at 0", () => {
  const { comp } = makeComp(() => makeCtx({}), 40, 25);
  assert.equal(comp.getScrollTop(), 0);
  assert.equal(comp.getMaxScrollTop(), 0);
  comp.scrollTo(999);
  assert.equal(comp.getScrollTop(), 0);
});

test("scroll state: overflowing content => maxScrollTop positive", () => {
  const { comp } = makeComp(() => tallCtx(), 15, 25);
  assert.ok(comp.getMaxScrollTop() > 0, "maxScrollTop should be positive for overflow");
  assert.equal(comp.getScrollTop(), 0);
});

test("scrollBy clamps to [0, maxScrollTop]", () => {
  const { comp } = makeComp(() => tallCtx(), 15, 25);
  const max = comp.getMaxScrollTop();
  comp.scrollBy(9999);
  assert.equal(comp.getScrollTop(), max);
  comp.scrollBy(-99999);
  assert.equal(comp.getScrollTop(), 0);
});

test("scrollToBottom / scrollToTop", () => {
  const { comp } = makeComp(() => tallCtx(), 15, 25);
  const max = comp.getMaxScrollTop();
  comp.scrollToBottom();
  assert.equal(comp.getScrollTop(), max);
  comp.scrollToTop();
  assert.equal(comp.getScrollTop(), 0);
});

test("getSeparatorColumn returns rawColumns - sidebarWidth", () => {
  const { comp } = makeComp(() => makeCtx({}), 15, 25, 80);
  assert.equal(comp.getSeparatorColumn(), 80 - 25);
});

test("no indicators when content fits", () => {
  const { comp, terminal } = makeComp(() => makeCtx({}), 40, 25);
  comp.paint();
  const out = terminal.writes.join("");
  assert.ok(!out.includes("lines below"), "unexpected bottom indicator");
  assert.ok(!out.includes("lines above"), "unexpected top indicator");
});

test("renders bottom indicator at top when overflowing", () => {
  const { comp, terminal } = makeComp(() => tallCtx(), 15, 25);
  comp.paint();
  const out = terminal.writes.join("");
  assert.ok(out.includes("lines below"), "expected bottom indicator at top");
  assert.ok(!out.includes("lines above"), "no top indicator expected at top");
});

test("renders top indicator when scrolled down (middle)", () => {
  const { comp, terminal } = makeComp(() => tallCtx(), 15, 25);
  const max = comp.getMaxScrollTop();
  // scrollBy triggers the first (full) paint at the new offset.
  comp.scrollBy(Math.max(1, Math.floor(max / 2)));
  const out = terminal.writes.join("");
  assert.ok(out.includes("lines above"), "expected top indicator in middle");
  assert.ok(out.includes("lines below"), "expected bottom indicator in middle");
});

test("at bottom: last line visible, no bottom indicator", () => {
  const { comp, terminal } = makeComp(() => tallCtx(), 15, 25);
  // scrollToBottom triggers the first (full) paint at the bottom offset.
  comp.scrollToBottom();
  const out = terminal.writes.join("");
  assert.ok(out.includes("not a git repo"), "last line should be visible at bottom");
  assert.ok(!out.includes("lines below"), "no bottom indicator expected at bottom");
  assert.ok(out.includes("lines above"), "top indicator expected at bottom");
});

test("doRender wrapper forces full repaint when pi emits a cursor-scroll sequence", () => {
  const terminal = makeTerminal(80, 15);
  let emitScrollSeq = false;
  const tui: any = {
    terminal,
    mode: "fullscreen",
    // Emits a reverse-index (\x1bM) scroll sequence only when flagged, to
    // simulate pi scrolling the main area during its own render cycle.
    doRender() {
      if (emitScrollSeq) terminal.write("\x1bM");
    },
  };
  const comp = new SidebarCompositor(tui, () => makeCtx({}), 25);
  comp.install();
  const countSeps = () => terminal.writes.join("").split("│").length - 1;

  // First render: full paint (every row gets a border separator).
  tui.doRender();
  assert.equal(countSeps(), 15, "first render should paint all rows");

  // Second render, unchanged, no scroll seq: differential paint writes no rows.
  terminal.writes.length = 0;
  tui.doRender();
  assert.equal(countSeps(), 0, "unchanged render should paint no rows");

  // Third render, unchanged, but pi emitted a cursor-scroll seq: full repaint.
  emitScrollSeq = true;
  terminal.writes.length = 0;
  tui.doRender();
  assert.equal(countSeps(), 15, "scroll sequence should force a full repaint");

  comp.dispose();
});

test("does not oscillate between last line and indicator on repeated paints at bottom", () => {
  const { comp, terminal } = makeComp(() => tallCtx(0), 15, 25);
  const c = comp as any; // reach private scroll state for repeated-paint assertions
  comp.scrollToBottom();
  for (let frame = 1; frame <= 5; frame++) {
    terminal.writes.length = 0;
    // Vary a non-last line (todo #1) and force a full paint so the whole
    // frame lands in the buffer for assertion.
    c.getCtx = () => tallCtx(frame);
    c.cacheValid = false;
    comp.paint();
    const out = terminal.writes.join("");
    assert.ok(out.includes("not a git repo"), `frame ${frame}: last line should stay visible`);
    assert.ok(!out.includes("lines below"), `frame ${frame}: should not flicker with bottom indicator`);
  }
});
