import type { MeshNode, MeshRun, NodeStatus, RunStatus } from "./manager.ts";

const terminalNodes = new Set<NodeStatus>(["succeeded", "failed", "cancelled", "skipped"]);
const nodeTransitions: Record<NodeStatus, ReadonlySet<NodeStatus>> = {
  queued: new Set(["running", "paused", "cancelled", "skipped", "failed"]),
  running: new Set(["queued", "paused", "succeeded", "failed", "cancelled"]),
  paused: new Set(["queued", "cancelled", "failed"]),
  succeeded: new Set(), failed: new Set(), cancelled: new Set(), skipped: new Set(),
};
const runTransitions: Record<RunStatus, ReadonlySet<RunStatus>> = {
  running: new Set(["paused", "cancelling", "succeeded", "failed", "cancelled"]),
  paused: new Set(["running", "cancelling", "cancelled"]),
  cancelling: new Set(["cancelled", "failed", "succeeded"]),
  succeeded: new Set(), failed: new Set(), cancelled: new Set(),
};

export function transitionNode(node: MeshNode, next: NodeStatus): boolean {
  if (node.status === next) return false;
  if (terminalNodes.has(node.status) || !nodeTransitions[node.status].has(next)) throw new Error(`Invalid node transition ${node.id}: ${node.status} -> ${next}`);
  node.status = next;
  return true;
}

export function transitionRun(run: MeshRun, next: RunStatus): boolean {
  if (run.status === next) return false;
  if (!runTransitions[run.status].has(next)) throw new Error(`Invalid run transition ${run.id}: ${run.status} -> ${next}`);
  run.status = next;
  return true;
}
