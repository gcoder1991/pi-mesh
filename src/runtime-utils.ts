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
  const activity = target.activity ??= { turns: 0, toolUses: 0, responseText: "", activeTools: [], usage: emptyUsage() };
  if (event.type === "turn_start") activity.turns++;
  if (event.type === "tool_execution_start" && event.toolName) { activity.toolUses++; activity.activeTools = [...activity.activeTools.filter((name) => name !== event.toolName), event.toolName].slice(-3); }
  if (event.type === "tool_execution_end" && event.toolName) activity.activeTools = activity.activeTools.filter((name) => name !== event.toolName);
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") activity.responseText = `${activity.responseText}${event.assistantMessageEvent.delta ?? ""}`.slice(-160);
  if (event.type === "message_end" && event.message?.role === "assistant") { addUsage(activity.usage, event.message.usage); activity.turns = Math.max(activity.turns, activity.usage.turns); }
}
