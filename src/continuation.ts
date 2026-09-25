import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MeshRun, MeshTask } from "./manager.ts";

// Intentionally not arbitrary run options: one predeclared, sequential, bounded
// successor, no growth/recovery/Direct permission and no recursive continuation.
export const ContinuationTaskSchema = Type.Object({
  agent: Type.String({ minLength: 1, maxLength: 128 }),
  task: Type.String({ minLength: 1, maxLength: 65536 }),
}, { additionalProperties: false });
export type ContinuationPermit = { bind(runId: string): void; complete(details: object): boolean; claim(callId: string): boolean; advance?(callId: string, runId: string): boolean };
export function requestContinuation(pi: ExtensionAPI, ctx: ExtensionContext, callId: string, input: unknown): ContinuationPermit {
  let permit: ContinuationPermit | undefined, open = true;
  pi.events.emit("pi-mesh:continuation:issue:v1", { version: 1, callId, input: JSON.stringify(input), sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
    reply: (value: ContinuationPermit) => { if (open && !permit && Object.isFrozen(value) && typeof value.bind === "function" && typeof value.complete === "function" && typeof value.claim === "function") permit = value; } });
  open = false;
  if (!permit || ((input as { autoContinuation?: unknown })?.autoContinuation && typeof permit.advance !== "function")) throw new Error("Continuation requires current Cross user-turn authorization; no run created");
  return permit;
}
export function continuationTasks(value: unknown): MeshTask[] {
  if (!Array.isArray(value) || !value.length || value.length > 4) throw new Error("continuationTasks requires 1-4 fixed tasks");
  return value.map((task, i) => {
    if (!task || Object.keys(task).some(k => k !== "agent" && k !== "task") || typeof task.agent !== "string" || !task.agent.trim() || task.agent.length > 128 || typeof task.task !== "string" || !task.task.trim() || Buffer.byteLength(task.task) > 65536) throw new Error("Continuation tasks accept only agent/task, with bounded text");
    return { id: `continuation-${i + 1}`, agent: task.agent, task: task.task, timeoutMs: 600_000, retries: 0 };
  });
}
export function successfulEpoch(run: MeshRun, epoch: number): boolean {
  return run.epoch === epoch && run.status === "succeeded" && !run.autoContinueBlocked && !run.cancelSource && run.nodes.every(n => n.status === "succeeded" && !n.autoContinueBlocked && !n.cancelSource && n.attempt === 1);
}
