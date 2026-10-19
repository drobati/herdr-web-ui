/**
 * What both sidebar lists share for Settings → Agents order: when each pane last changed, from
 * herdr's state_change_seq kept in step with pushed statuses, on one count across PCs, and DONE as
 * herdr's TUI draws it, a finish not looked at yet. MachineSidebar owns it (`useSidebarActivityState`)
 * and provides it; the workspace rows and the Agents list read it (`useSidebarActivity`). The
 * logic itself is in lib/sidebarOrder.ts.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import { liveSeqs, newRecencyMemory, newSeenMemory, newSeqMemory, observedRecency, seenStatuses, shownStatus, type RecencyMemory, type SeenMemory, type SeqMemory } from "./sidebarOrder.ts";

export interface SidebarActivity {
  /** when this page saw each pane on a PC change, on one count across PCs; a pushed status change counts at once */
  seqs(machineId: string): ReadonlyMap<string, number>;
  /** the status a row draws for a pane */
  status(machineId: string, pane: Pick<HerdrPane, "pane_id" | "agent_status" | "background_wait">): AgentStatus | undefined;
}

const NO_SEQS: ReadonlyMap<string, number> = new Map();
const SidebarActivityContext = createContext<SidebarActivity>({ seqs: () => NO_SEQS, status: (_machineId, pane) => shownStatus(pane) });
export const SidebarActivityProvider = SidebarActivityContext.Provider;
export const useSidebarActivity = (): SidebarActivity => useContext(SidebarActivityContext);

const pageShown = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";

/** `selectedMachineId`/`selectedPaneId`: the pane on screen, looked at while the page is shown */
export function useSidebarActivityState(machines: readonly Machine[], selectedMachineId?: string, selectedPaneId?: string | null): SidebarActivity {
  const memories = useRef(new Map<string, { live: SeqMemory; recency: RecencyMemory; seen: SeenMemory }>());
  const counter = useRef({ last: 0 });
  const [shown, setShown] = useState(pageShown);
  useEffect(() => {
    const update = () => setShown(pageShown());
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const byMachine = useMemo(() => new Map(machines.map((machine) => {
    let memory = memories.current.get(machine.id);
    if (!memory) memories.current.set(machine.id, memory = { live: newSeqMemory(), recency: newRecencyMemory(), seen: newSeenMemory() });
    const live = liveSeqs(machine.snapshot, memory.live);
    const viewing = shown && machine.id === selectedMachineId ? selectedPaneId ?? null : null;
    return [machine.id, { seqs: observedRecency(live, memory.recency, counter.current), statuses: seenStatuses(machine.snapshot, live, viewing, memory.seen) }] as const;
  })), [machines, shown, selectedMachineId, selectedPaneId]);
  return useMemo<SidebarActivity>(() => ({
    seqs: (machineId) => byMachine.get(machineId)?.seqs ?? NO_SEQS,
    status: (machineId, pane) => {
      const statuses = byMachine.get(machineId)?.statuses;
      return shownStatus({ ...pane, agent_status: statuses?.get(pane.pane_id) ?? pane.agent_status });
    },
  }), [byMachine]);
}
