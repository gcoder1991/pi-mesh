import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPiMesh from "../../src/extension.ts";

export function extensionHarness() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const emitted: Array<{ event: string; payload: any }> = [];
  const messages: any[] = [];
  const events = {
    on(event: string, handler: (...args: any[]) => any) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); return () => handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== handler)); },
    emit(event: string, payload?: any) { emitted.push({ event, payload }); for (const handler of handlers.get(event) ?? []) handler(payload); },
  };
  const pi: any = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    getAllTools() { return [...tools.values()]; },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerShortcut(key: string, shortcut: any) { shortcuts.set(key, shortcut); },
    on(event: string, handler: any) { const list = handlers.get(`pi:${event}`) ?? []; list.push(handler); handlers.set(`pi:${event}`, list); },
    events,
    sendMessage(message: any, options: any) { messages.push({ message, options }); },
  } satisfies Partial<ExtensionAPI>;
  registerPiMesh(pi);
  return { pi, tools, commands, shortcuts, handlers, emitted, messages, shutdown: async () => { for (const handler of handlers.get("pi:session_shutdown") ?? []) await handler({ reason: "quit" }, {}); } };
}

export function context(root: string, options: { trusted?: boolean; branch?: any[]; modelRegistry?: any; ui?: any } = {}): any {
  return {
    cwd: root, mode: options.ui ? "tui" : "print", hasUI: Boolean(options.ui), isProjectTrusted: () => options.trusted ?? true,
    sessionManager: { getBranch: () => options.branch ?? [], getSessionDir: () => path.join(root, ".pi", "sessions"), getSessionId: () => "test-session" },
    modelRegistry: options.modelRegistry ?? { getAvailable: () => [] },
    ui: options.ui ?? { notify() {}, select: async () => undefined, input: async () => undefined, editor: async () => undefined, setWidget() {} },
  };
}
