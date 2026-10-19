/**
 * The sidebar's Activity order for the Agents list.
 *
 * Activity is herdr's TUI priority order: state first, then the latest change, across every PC.
 * Recency starts from herdr's `state_change_seq`, one counter per herdr session bumped on every
 * agent state change. `session.snapshot` leaves it off `panes` and carries it on `agents`.
 */
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { knownStatus, paneStatus } from "./status.ts";

/** Each agent pane's `state_change_seq`. Panes without an agent have none. */
export function stateSeqs(snapshot: Pick<SessionSnapshot, "agents"> | null | undefined): Map<string, number> {
  const seqs = new Map<string, number>();
  for (const agent of snapshot?.agents ?? []) {
    const seq = agent.state_change_seq;
    if (seq !== undefined && Number.isFinite(seq)) seqs.set(agent.pane_id, seq);
  }
  return seqs;
}

/**
 * What `liveSeqs` remembers between snapshots: each pane's last status, the changes it dated
 * itself (`bumped`), and herdr's own counter per pane at the last call (`real`).
 */
export interface SeqMemory { status: Map<string, unknown>; bumped: Map<string, number>; real: Map<string, number> }
export const newSeqMemory = (): SeqMemory => ({ status: new Map(), bumped: new Map(), real: new Map() });

/**
 * `stateSeqs`, kept in step with pushed statuses. A pane-status push lands in the snapshot at once
 * (applyPaneStatus), but the counter only comes with the next roster read, up to POLL_MS later: a
 * pane sent a message would sit in its old place. So a status that changed since the last call is
 * dated now, just above every counter known; herdr's own counter for that change is higher and takes
 * over when it comes. A change that arrives with a new counter of herdr's (a roster read that saw it
 * first) keeps that counter, so herdr's order between changes stands, and drops the pane's earlier
 * stand-in, which dated an older change. A counter that went back means herdr restarted: every
 * stand-in is dropped. Mutates `memory`.
 */
export function liveSeqs(snapshot: Pick<SessionSnapshot, "agents" | "panes"> | null | undefined, memory: SeqMemory): Map<string, number> {
  const seqs = stateSeqs(snapshot);
  const panes = snapshot?.panes ?? [];
  if ([...seqs].some(([id, real]) => real < (memory.real.get(id) ?? real))) memory.bumped.clear();
  let top = Math.max(0, ...seqs.values(), ...memory.bumped.values());
  for (const pane of panes) {
    const changed = memory.status.has(pane.pane_id) && memory.status.get(pane.pane_id) !== pane.agent_status;
    const real = seqs.get(pane.pane_id);
    const before = memory.real.get(pane.pane_id);
    if (changed && real !== undefined) {
      if (before !== undefined && real <= before) memory.bumped.set(pane.pane_id, top += 0.001);
      // herdr's counter moved with the change: it dates it, and a stand-in from before is stale
      else memory.bumped.delete(pane.pane_id);
    }
    memory.status.set(pane.pane_id, pane.agent_status);
  }
  for (const [id, real] of seqs) memory.real.set(id, real);
  const open = new Set(panes.map((pane) => pane.pane_id));
  if (panes.length > 0) {
    for (const id of memory.status.keys()) if (!open.has(id)) memory.status.delete(id);
    for (const id of memory.real.keys()) if (!open.has(id)) memory.real.delete(id);
  }
  for (const [id, bump] of memory.bumped) {
    const real = seqs.get(id);
    if (real === undefined || real > bump) memory.bumped.delete(id);
    else seqs.set(id, bump);
  }
  return seqs;
}

/** The status to draw: herdr's own, or BG while the pane holds its turn for background work. */
export function shownStatus(pane: Pick<HerdrPane, "agent_status" | "background_wait">): AgentStatus | undefined {
  return pane.background_wait ? paneStatus(pane) : pane.agent_status;
}

/**
 * When this page saw each pane's counter move, on one count shared by every PC (herdr's
 * client/shell/endpoints.rs `agent_recency`): herdr counts per session, so its counters do not
 * compare across PCs. A pane first seen, or whose counter moved, takes the next count, in its
 * counter's order. Mutates `memory` (each pane's last counter and count) and `counter`.
 */
export interface RecencyMemory { seq: Map<string, number>; recent: Map<string, number> }
export const newRecencyMemory = (): RecencyMemory => ({ seq: new Map(), recent: new Map() });
export function observedRecency(seqs: ReadonlyMap<string, number>, memory: RecencyMemory, counter: { last: number }): Map<string, number> {
  for (const [id, seq] of [...seqs].sort((a, b) => a[1] - b[1])) {
    if (memory.seq.get(id) !== seq) memory.recent.set(id, ++counter.last);
    memory.seq.set(id, seq);
  }
  for (const id of memory.seq.keys()) if (!seqs.has(id)) { memory.seq.delete(id); memory.recent.delete(id); }
  return new Map(memory.recent);
}

/**
 * What `seenStatuses` remembers: each pane's last herdr status, the panes seen working, the counter of
 * each finish not looked at yet (`completed`), and the counter each pane was last looked at. `saved`
 * is what outlives a reload: herdr's own counter each pane was looked at, with `top`, herdr's highest
 * counter then; `dirty` says it changed since it was stored.
 */
export interface SeenMemory { status: Map<string, unknown>; working: Set<string>; completed: Map<string, number>; viewed: Map<string, number>; saved: Map<string, number>; top: number; dirty: boolean }
export interface SavedSeen { top: number; panes: [string, number][] }
export const newSeenMemory = (saved?: SavedSeen | null): SeenMemory => ({
  status: new Map(), working: new Set(), completed: new Map(), viewed: new Map(), saved: new Map(saved?.panes ?? []), top: saved?.top ?? 0, dirty: false,
});
export const savedSeen = (memory: SeenMemory): SavedSeen => ({ top: memory.top, panes: [...memory.saved] });

/**
 * DONE as herdr's TUI draws it (client/shell/endpoint_agent_state.rs): a finish not looked at yet. A
 * pane seen working that comes to rest, or one herdr calls done, has finished; once it is shown
 * (`viewing`, the pane on screen) at or after that counter it reads idle. herdr moving a done to idle
 * (looked at in the TUI) clears it too. herdr's done on a pane first seen since a reload, looked at
 * before it at or after that counter (`saved`), stays idle. `seqs` is `liveSeqs`. Mutates `memory`.
 */
export function seenStatuses(snapshot: Pick<SessionSnapshot, "panes" | "agents"> | null | undefined, seqs: ReadonlyMap<string, number>, viewing: string | null, memory: SeenMemory): Map<string, AgentStatus> {
  const shown = new Map<string, AgentStatus>();
  const panes = snapshot?.panes ?? [];
  const real = stateSeqs(snapshot);
  if (real.size > 0) {
    const top = Math.max(...real.values());
    // herdr's counter went back: it restarted, and the counters looked at are another session's
    if (top < memory.top && memory.saved.size > 0) { memory.saved.clear(); memory.dirty = true; }
    if (top !== memory.top) { memory.top = top; memory.dirty = true; }
  }
  for (const pane of panes) {
    const id = pane.pane_id;
    const seq = seqs.get(id);
    const status = knownStatus(pane.agent_status);
    const before = memory.status.get(id);
    memory.status.set(id, status);
    if (seq === undefined) continue;
    if (status === "working") { memory.working.add(id); memory.completed.delete(id); }
    else if (status === "done" || status === "idle") {
      if (memory.working.delete(id)) memory.completed.set(id, seq);
      else if (status === "done" && !memory.completed.has(id)) {
        memory.completed.set(id, seq);
        if (before === undefined && (memory.saved.get(id) ?? -1) >= (real.get(id) ?? Infinity)) memory.viewed.set(id, seq);
      } else if (status === "idle" && before === "done") memory.completed.delete(id);
    } else { memory.working.delete(id); memory.completed.delete(id); }
    if (id === viewing) {
      memory.viewed.set(id, seq);
      const own = real.get(id);
      if (own !== undefined && memory.saved.get(id) !== own) { memory.saved.set(id, own); memory.dirty = true; }
    }
    const finish = memory.completed.get(id);
    if (status === "done" || status === "idle") shown.set(id, finish !== undefined && !((memory.viewed.get(id) ?? -1) >= finish) ? "done" : "idle");
  }
  if (panes.length > 0) {
    const open = new Set(panes.map((pane) => pane.pane_id));
    for (const map of [memory.status, memory.completed, memory.viewed]) for (const id of map.keys()) if (!open.has(id)) map.delete(id);
    for (const id of memory.working) if (!open.has(id)) memory.working.delete(id);
    for (const id of memory.saved.keys()) if (!open.has(id)) { memory.saved.delete(id); memory.dirty = true; }
  }
  return shown;
}

/** a state's rank in herdr's TUI priority order (client/shell.rs `status_priority`); BG is busy, as RUN */
const PRIORITY: Readonly<Record<string, number>> = { blocked: 4, done: 3, working: 2, waiting: 2, idle: 1 };

/**
 * Rows in Activity order, herdr's TUI priority order (client/shell/aggregate_navigation.rs): a PC
 * that is not connected last, then blocked, done, working, idle, then the latest change seen, then
 * the order given.
 */
export function activityOrder<T>(rows: readonly T[], rowOf: (row: T) => { status: AgentStatus | undefined; recent: number | undefined; stale?: boolean }): T[] {
  return rows
    .map((row, index) => {
      const { status, recent, stale } = rowOf(row);
      return { row, index, stale: stale ? 1 : 0, rank: PRIORITY[knownStatus(status)] ?? 0, recent: recent ?? -1 };
    })
    .sort((a, b) => a.stale - b.stale || b.rank - a.rank || b.recent - a.recent || a.index - b.index)
    .map((entry) => entry.row);
}
