import * as crypto from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ackMessage, growthProposals, messages, putGrowth, putMessage, readJson, runFile, type ControlMessage, type GrowthProposal } from "./store.ts";
import type { MeshRun, MeshTask } from "./manager.ts";
import { MeshTaskSchema } from "./schemas.ts";


function boundedJson(value: unknown): string {
  const result = truncateHead(JSON.stringify(value), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  return result.truncated ? `${result.content}\n[Output truncated; use narrower inbox filters or inspect the project spool.]` : result.content;
}
function boundedDetails(value: Record<string, unknown>): Record<string, unknown> {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  return bytes <= DEFAULT_MAX_BYTES ? value : { truncated: true, bytes };
}

const Params = Type.Object({
  action: StringEnum(["send", "broadcast", "reply", "inbox", "ack", "grow"] as const),
  to: Type.Optional(Type.String({ maxLength: 64 })), content: Type.Optional(Type.String({ maxLength: 1_048_576 })), messageId: Type.Optional(Type.String({ maxLength: 128 })),
  reason: Type.Optional(Type.String({ maxLength: 16384 })), tasks: Type.Optional(Type.Array(MeshTaskSchema, { minItems: 1, maxItems: 16 })),
}, { additionalProperties: false });

export default function registerMeshControl(pi: ExtensionAPI): void {
  const runId = process.env.PI_MESH_RUN_ID;
  const nodeId = process.env.PI_MESH_NODE_ID;
  const attempt = Number(process.env.PI_MESH_ATTEMPT);
  const root = process.env.PI_MESH_ROOT;
  if (!runId || !nodeId || !Number.isInteger(attempt) || attempt < 1 || !root) return;

  pi.registerTool({
    name: "mesh_control",
    label: "Mesh Control",
    description: "Child-safe mailbox and growth proposal tool. Growth only proposes tasks; the host must approve and commit them.",
    parameters: Params,
    async execute(_id, rawParams): Promise<any> {
      const params = rawParams;
      const run = readJson<MeshRun>(runFile(root, runId));
      const caller = run?.nodes.find((node) => node.id === nodeId);
      if (!run || !caller || caller.status !== "running" || caller.attempt !== attempt || run.status !== "running") throw new Error("Mesh child identity is no longer active");
      if (params.action === "inbox") {
        const inbox = messages(root, runId).filter((message) => message.to === nodeId && !message.ackedAt);
        const proposals = growthProposals<MeshTask[]>(root, runId).filter((proposal) => proposal.requester === nodeId);
        return { content: [{ type: "text", text: boundedJson({ inbox, growth: proposals }) }], details: boundedDetails({ inboxCount: inbox.length, growthCount: proposals.length, inbox: inbox.slice(0, 256), growth: proposals.slice(0, 256) }) };
      }
      if (params.action === "ack") {
        if (!params.messageId || !ackMessage(root, runId, params.messageId, nodeId)) throw new Error("messageId is not an unacked message for this node");
        return { content: [{ type: "text", text: `Acknowledged ${params.messageId}.` }], details: {} };
      }
      if (params.action === "grow") {
        if (!params.reason?.trim() || !params.tasks?.length) throw new Error("reason and tasks are required for grow");
        if (caller.allowedSubagents !== "all") {
          const allowed = new Set((caller.allowedSubagents ?? []).map((name) => name.toLowerCase()));
          const denied = params.tasks.map((task) => task.agent).filter((name) => !allowed.has(name.toLowerCase()));
          if (denied.length) throw new Error(`Agent ${caller.agent} cannot request growth for: ${[...new Set(denied)].join(", ")}`);
        }
        const proposal: GrowthProposal<MeshTask[]> = {
          id: crypto.randomUUID(), runId, requester: nodeId, reason: params.reason.trim(), tasks: params.tasks as MeshTask[], status: "proposed",
          baseRevision: run.revision, requesterAttempt: attempt, createdAt: Date.now(),
        };
        if (Buffer.byteLength(JSON.stringify(proposal), "utf8") > 1024 * 1024) throw new Error("Growth proposal exceeds 1048576 bytes");
        putGrowth(root, proposal);
        return { content: [{ type: "text", text: `Growth proposed: ${proposal.id}. Host approval is required.` }], details: boundedDetails({ proposal }) };
      }

      const all = messages(root, runId);
      let recipients: string[];
      let replyTo: string | undefined;
      if (params.action === "reply") {
        if (!params.messageId) throw new Error("messageId is required for reply");
        const original = all.find((message) => message.id === params.messageId && message.to === nodeId);
        if (!original) throw new Error("Cannot reply to an unknown message");
        recipients = [original.from];
        replyTo = original.id;
      } else if (params.action === "broadcast") {
        recipients = run.nodes.map((node) => node.id).filter((id) => id !== nodeId);
      } else {
        if (!params.to) throw new Error("to is required for send");
        recipients = [params.to];
      }
      if (recipients.some((id) => id !== "host" && !run.nodes.some((node) => node.id === id))) throw new Error("Unknown recipient node");
      const payloadMaxBytes = run.messagePayloadMaxBytes ?? 32 * 1024;
      const recipientUnreadMaxBytes = run.recipientUnreadMaxBytes ?? 1024 * 1024;
      if (!params.content?.trim() || Buffer.byteLength(params.content, "utf8") > payloadMaxBytes) throw new Error(`content must be 1-${payloadMaxBytes} bytes`);
      const sent: ControlMessage[] = recipients.map((to) => ({
        id: crypto.randomUUID(), runId, from: nodeId, to, content: params.content!.trim(), replyTo, senderAttempt: attempt, createdAt: Date.now(),
      }));
      for (const message of sent) putMessage(root, message, { payloadMaxBytes, recipientUnreadMaxBytes });
      return { content: [{ type: "text", text: `Queued ${sent.length} mailbox message(s).` }], details: boundedDetails({ messages: sent }) };
    },
  });
}
