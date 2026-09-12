import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let calls = 0;

export default function registerMockProvider(pi: ExtensionAPI): void {
  pi.registerProvider("pi-mesh-mock", {
    name: "pi-mesh mock provider",
    baseUrl: "file://pi-mesh-mock",
    apiKey: "mock",
    api: "openai-completions",
    models: [{
      id: "mock-1",
      name: "Mock 1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 1_024,
    }],
    streamSimple(model: Model<any>, _context: Context, _options?: SimpleStreamOptions) {
      const stream = createAssistantMessageEventStream();
      const toolCall = calls++ === 0;
      if (!toolCall) {
        assert.equal(calls, 2, "exactly one tool call followed by completion");
        const receipt = _context.messages.find(message => message.role === "toolResult" && message.toolCallId === "mesh-control-call");
        assert.ok(receipt && receipt.role === "toolResult");
        assert.equal(receipt.toolName, "mesh_control"); assert.equal(receipt.isError, false);
        const text = receipt.content.find(part => part.type === "text"); assert.ok(text && text.type === "text");
        assert.deepEqual(JSON.parse(text.text), { inbox: [], growth: [] });
      }
      const message: AssistantMessage = {
        role: "assistant",
        content: toolCall
          ? [{ type: "toolCall", id: "mesh-control-call", name: "mesh_control", arguments: { action: "inbox" } }]
          : [{ type: "text", text: "mesh control ok" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: toolCall ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        if (toolCall) {
          const call = message.content[0];
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...message, content: call.type === "toolCall" ? [{ ...call, arguments: {} }] : [] } });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.type === "toolCall" ? call.arguments : {}), partial: message });
          if (call.type === "toolCall") stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        } else {
          stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }] } });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "mesh control ok", partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: "mesh control ok", partial: message });
        }
        stream.push({ type: "done", reason: toolCall ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    },
  });
}
