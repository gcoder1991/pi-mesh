import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { buildSessionContext, convertToLlm, serializeConversation, type SessionEntry } from "@earendil-works/pi-coding-agent";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  turns: number;
}

export interface AgentActivity {
  turns: number;
  toolUses: number;
  responseText: string;
  thinkingText: string;
  activeTools: string[];
  usage: Usage;
}

interface UsageSource {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

interface ActivityEvent {
  type: string;
  toolName?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  message?: { role?: string; usage?: UsageSource };
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function addUsage(target: Usage, source?: UsageSource): void {
  target.turns++;
  target.input += source?.input ?? 0;
  target.output += source?.output ?? 0;
  target.cacheRead += source?.cacheRead ?? 0;
  target.cacheWrite += source?.cacheWrite ?? 0;
  target.cost += source?.cost?.total ?? 0;
  target.costInput = (target.costInput ?? 0) + (source?.cost?.input ?? 0);
  target.costOutput = (target.costOutput ?? 0) + (source?.cost?.output ?? 0);
  target.costCacheRead = (target.costCacheRead ?? 0) + (source?.cost?.cacheRead ?? 0);
  target.costCacheWrite = (target.costCacheWrite ?? 0) + (source?.cost?.cacheWrite ?? 0);
}

export function appendUtf8Tail(current: Buffer, chunk: Buffer, limit: number): Buffer {
  const combined = Buffer.concat([current, chunk]);
  if (combined.length <= limit) return combined;
  let start = combined.length - limit;
  while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start++;
  return combined.subarray(start);
}

export function truncateUtf8(text: string, limit: number, keep: "head" | "tail" = "head"): string {
  limit = Math.max(0, Math.floor(limit));
  if (!limit) return "";
  // A UTF-16 code unit needs at least one UTF-8 byte. Bound the allocation even
  // when callers pass a very large message, and do not split surrogate pairs.
  if (text.length > limit) {
    if (keep === "tail") {
      let start = text.length - limit;
      if (text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++;
      text = text.slice(start);
    } else {
      let end = limit;
      if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
      text = text.slice(0, end);
    }
  }
  const buffer = Buffer.from(text);
  if (buffer.length <= limit) return text;
  if (keep === "tail") {
    let start = buffer.length - limit;
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
    return buffer.subarray(start).toString("utf8");
  }
  let end = limit;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

export function trackActivity(target: { activity?: AgentActivity }, event: ActivityEvent): void {
  const activity = target.activity ??= { turns: 0, toolUses: 0, responseText: "", thinkingText: "", activeTools: [], usage: emptyUsage() };
  if (event.type === "turn_start") activity.turns++;
  if (event.type === "tool_execution_start" && event.toolName) { activity.toolUses++; activity.activeTools = [...activity.activeTools.filter((name) => name !== event.toolName), event.toolName].slice(-3); }
  if (event.type === "tool_execution_end" && event.toolName) activity.activeTools = activity.activeTools.filter((name) => name !== event.toolName);
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") activity.responseText = `${activity.responseText}${event.assistantMessageEvent.delta ?? ""}`.slice(-160);
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") activity.thinkingText = `${activity.thinkingText}${event.assistantMessageEvent.delta ?? ""}`.slice(-160);
  if (event.type === "message_end" && event.message?.role === "assistant") { addUsage(activity.usage, event.message.usage); activity.turns = Math.max(activity.turns, activity.usage.turns); }
}

/** Sum already-accounted execution totals, without synthesizing turns. */
export function mergeUsage(left: Usage | undefined, right: Usage): Usage {
  const result = { ...emptyUsage(), ...left };
  for (const key of Object.keys(right) as Array<keyof Usage>) result[key] = (result[key] ?? 0) + (right[key] ?? 0);
  return result;
}

export function boundedDisplay(text: string): string {
  const head = truncateUtf8(text, 50 * 1024 - 128);
  const lines = head.split("\n");
  const content = lines.slice(0, 1998).join("\n");
  return content !== text ? `${content}\n[truncated display; consult the artifact]` : text;
}

export function readBoundedFile(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(50 * 1024);
    const size = fs.fstatSync(fd).size;
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return boundedDisplay(new StringDecoder("utf8").write(buffer.subarray(0, read)) + (size > read ? "\n[truncated file view]" : ""));
  } finally { fs.closeSync(fd); }
}

/** Reject huge groups before SDK serialization, including nested tool arguments.
 * Traversal stops at the budget; it never stringifies a full oversized history. */
function fitsSerialization(value: unknown, budget: number): boolean {
  const stack: unknown[] = [value]; let size = 0;
  while (stack.length) {
    const item = stack.pop(); size += 16;
    if (typeof item === "string") { if (item.length > budget - size) return false; size += Buffer.byteLength(item) * 6; }
    else if (item && typeof item === "object") {
      if (Array.isArray(item)) { if (item.length > (budget - size) / 16) return false; for (const child of item) stack.push(child); }
      else for (const key in item) { size += key.length * 6; stack.push((item as Record<string, unknown>)[key]); if (stack.length * 16 + size > budget) return false; }
    }
    if (size > budget) return false;
  }
  return true;
}

export function inheritedContext(branch: SessionEntry[], budget = 128 * 1024): string {
  const messages = buildSessionContext(branch).messages;
  const selected: string[] = []; let bytes = 0; let truncated = false;
  // An assistant and its following tool results are indivisible. Also discard
  // orphan/incomplete tool groups (Host may be executing sibling tools now).
  for (let end = messages.length; end > 0;) {
    let start = end - 1;
    while (start > 0 && messages[start]?.role === "toolResult") start--;
    const group = messages.slice(start, end); end = start;
    const first = group[0];
    if (first?.role === "toolResult") { truncated = true; continue; }
    if (first?.role === "assistant") {
      const calls = first.content.filter((block) => block.type === "toolCall").map((block) => block.id);
      const results = group.slice(1).filter((message) => message.role === "toolResult").map((message) => message.toolCallId);
      if (calls.length !== results.length || calls.some((id) => !results.includes(id))) { truncated = true; continue; }
    }
    if (!fitsSerialization(group, budget - bytes - 256)) { truncated = true; continue; }
    const text = serializeConversation(convertToLlm(group));
    const size = Buffer.byteLength(text) + 2;
    if (bytes + size > budget - 256) { truncated = true; continue; }
    selected.push(text); bytes += size;
  }
  return `${truncated ? "[Parent context truncated: only complete messages/tool groups retained; SDK summaries honored.]\n" : ""}${selected.reverse().join("\n\n")}`;
}
