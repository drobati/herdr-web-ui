import { describe, expect, it } from "bun:test";

import type { PaneInfo } from "../../shared/protocol.ts";
import { activityOrder, liveSeqs, newRecencyMemory, newSeenMemory, newSeqMemory, observedRecency, seenStatuses, shownStatus, stateSeqs } from "./sidebarOrder.ts";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.ts";

const pane = (id: string, agent_status: string, workspace_id = `w-${id}`) => ({ pane_id: id, workspace_id, agent_status }) as PaneInfo;
const ids = (list: PaneInfo[]) => list.map((entry) => entry.pane_id);

describe("state_change_seq", () => {
  it("is read from the snapshot's agents, the only place session.snapshot carries it", () => {
    const seqs = stateSeqs({ agents: [{ pane_id: "a", state_change_seq: 7 }, { pane_id: "b" }, { pane_id: "c", state_change_seq: "9" }] } as never);
    expect([...seqs]).toEqual([["a", 7]]);
    expect(stateSeqs(null).size).toBe(0);
  });
});

describe("live counters", () => {
  const snap = (statuses: Record<string, string>, seqs: Record<string, number>) => ({
    panes: Object.entries(statuses).map(([id, status]) => pane(id, status)),
    agents: Object.entries(seqs).map(([pane_id, state_change_seq]) => ({ pane_id, state_change_seq })),
  }) as never;

  it("dates a pushed status change above every known counter until herdr's own counter comes", () => {
    const memory = newSeqMemory();
    expect([...liveSeqs(snap({ a: "idle", b: "done" }, { a: 5, b: 9 }), memory)]).toEqual([["a", 5], ["b", 9]]);
    // a is sent a message: the push changes its status, the counter is still 5
    const pushed = liveSeqs(snap({ a: "working", b: "done" }, { a: 5, b: 9 }), memory);
    expect(pushed.get("a")!).toBeGreaterThan(9);
    // it finishes before the roster is read again: dated later still, so it is a new change
    const finished = liveSeqs(snap({ a: "done", b: "done" }, { a: 5, b: 9 }), memory);
    expect(finished.get("a")!).toBeGreaterThan(pushed.get("a")!);
    // herdr's counter arrives and replaces the stand-in
    expect(liveSeqs(snap({ a: "done", b: "done" }, { a: 11, b: 9 }), memory).get("a")).toBe(11);
    expect(memory.bumped.size).toBe(0);
  });

  it("keeps herdr's counters for changes a roster read brings with their counters", () => {
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "working", b: "working" }, { a: 5, b: 6 }), memory);
    // both finish between two roster reads, a after b: herdr's counters say so, and stand
    const read = liveSeqs(snap({ a: "done", b: "done" }, { a: 21, b: 20 }), memory);
    expect([...read]).toEqual([["a", 21], ["b", 20]]);
    expect(ids(activityOrder([pane("b", "done"), pane("a", "done")], (row) => ({ status: row.agent_status, recent: read.get(row.pane_id) })))).toEqual(["a", "b"]);
    expect(memory.bumped.size).toBe(0);
  });

  it("drops its stand-ins when herdr's counters go back (herdr restarted)", () => {
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "idle", b: "done" }, { a: 50, b: 49 }), memory);
    liveSeqs(snap({ a: "working", b: "done" }, { a: 50, b: 49 }), memory);
    expect(memory.bumped.size).toBe(1);
    const restarted = liveSeqs(snap({ a: "working", b: "done" }, { a: 2, b: 1 }), memory);
    expect([...restarted]).toEqual([["a", 2], ["b", 1]]);
    expect(memory.bumped.size).toBe(0);
  });

  it("does not date a pane's first sighting, or a pane with no counter", () => {
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "idle", shell: "unknown" }, { a: 5 }), memory);
    const next = liveSeqs(snap({ a: "idle", shell: "working", c: "done" }, { a: 5, c: 7 }), memory);
    expect([...next]).toEqual([["a", 5], ["c", 7]]);
  });
});

describe("activity order", () => {
  const agents = [pane("idle", "idle"), pane("working", "working"), pane("blocked", "blocked"), pane("done-old", "done"), pane("done-new", "done"), pane("nocount", "idle")];
  const seqs = new Map([["idle", 50], ["working", 10], ["blocked", 1], ["done-old", 20], ["done-new", 30]]);
  const order = (rows: PaneInfo[], counters = seqs, stale = new Set<string>()) =>
    ids(activityOrder(rows, (row) => ({ status: row.agent_status, recent: counters.get(row.pane_id), stale: stale.has(row.pane_id) })));

  it("ranks states as herdr's TUI does, blocked, done, working, idle, then the latest change", () => {
    expect(order(agents)).toEqual(["blocked", "done-new", "done-old", "working", "idle", "nocount"]);
  });

  it("puts a PC that is not connected last, whatever its states", () => {
    expect(order(agents, seqs, new Set(["blocked"]))).toEqual(["done-new", "done-old", "working", "idle", "nocount", "blocked"]);
  });

  it("keeps the given order between equals", () => {
    const fresh = [...agents, pane("new", "idle"), pane("tie", "idle")];
    expect(order(fresh, new Map([...seqs, ["new", 99]])).slice(-4)).toEqual(["new", "idle", "nocount", "tie"]);
  });
});

describe("seen statuses", () => {
  const panes = (statuses: Record<string, string>) => ({ panes: Object.entries(statuses).map(([id, status]) => pane(id, status)) }) as never;
  const counters = (entries: Record<string, number>) => new Map(Object.entries(entries));

  it("shows a finish as done until its pane is on screen, then idle", () => {
    const memory = newSeenMemory();
    seenStatuses(panes({ a: "working", b: "idle" }), counters({ a: 1, b: 1 }), null, memory);
    expect(seenStatuses(panes({ a: "idle", b: "idle" }), counters({ a: 2, b: 1 }), null, memory)).toEqual(new Map([["a", "done"], ["b", "idle"]]));
    expect(seenStatuses(panes({ a: "idle", b: "idle" }), counters({ a: 2, b: 1 }), "a", memory).get("a")).toBe("idle");
    // looked at once is enough: leaving the pane keeps it idle
    expect(seenStatuses(panes({ a: "idle", b: "idle" }), counters({ a: 2, b: 1 }), null, memory).get("a")).toBe("idle");
  });

  it("never shows done for the pane on screen as it finishes, and takes herdr's done as not looked at", () => {
    const memory = newSeenMemory();
    seenStatuses(panes({ a: "working", b: "done" }), counters({ a: 1, b: 1 }), "a", memory);
    const next = seenStatuses(panes({ a: "done", b: "done" }), counters({ a: 2, b: 1 }), "a", memory);
    expect(next).toEqual(new Map([["a", "idle"], ["b", "done"]]));
    // looked at in herdr's TUI: herdr moves it to idle
    expect(seenStatuses(panes({ a: "done", b: "idle" }), counters({ a: 2, b: 2 }), "a", memory).get("b")).toBe("idle");
  });
});

describe("observed recency", () => {
  it("counts on one count across PCs, in each PC's counter order, only when a counter moves", () => {
    const counter = { last: 0 };
    const a = newRecencyMemory();
    const b = newRecencyMemory();
    expect([...observedRecency(new Map([["x", 9], ["y", 3]]), a, counter)]).toEqual([["y", 1], ["x", 2]]);
    // the other PC's counter is lower, but it was seen later
    expect(observedRecency(new Map([["z", 1]]), b, counter).get("z")).toBe(3);
    expect(observedRecency(new Map([["x", 9], ["y", 4]]), a, counter)).toEqual(new Map([["y", 4], ["x", 2]]));
    // a pane gone is forgotten
    expect([...observedRecency(new Map([["y", 4]]), a, counter)]).toEqual([["y", 4]]);
  });
});

describe("shown status", () => {
  it("shows BG while a pane holds its turn for background work, herdr's own status otherwise", () => {
    const held = { ...pane("a", "done"), background_wait: true as const };
    expect(shownStatus(held)).toBe("waiting");
    expect(shownStatus({ ...held, agent_status: "blocked" })).toBe("blocked");
    expect(shownStatus(pane("a", "done"))).toBe("done");
  });
});

it("defaults to herdr's order, and accepts only known values", () => {
  expect(DEFAULT_SETTINGS.agentOrder).toBe("workspace");
  expect(sanitizeSettings({ agentOrder: "activity" })).toMatchObject({ agentOrder: "activity" });
  expect(sanitizeSettings({ agentOrder: "recent" })).toMatchObject({ agentOrder: "workspace" });
});
