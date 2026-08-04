const SOURCE = "pi-mesh:herdr";
const ACTIVE_STATUSES = new Set(["queued", "running", "paused"]);

export interface HerdrSidebarAgent {
  id: string;
  agent: string;
  status: string;
}

export interface HerdrSidebarOptions {
  events: { emit(event: string, data: unknown): void };
  getAgents(): Iterable<HerdrSidebarAgent>;
  runHerdr(args: readonly string[]): void | Promise<void>;
  env?: Record<string, string | undefined>;
  pollMs?: number;
  ttlMs?: number;
  refreshMs?: number;
}

export interface HerdrSidebar {
  sessionStarted(hasUI: boolean): void;
  refresh(): void;
  flush(): Promise<void>;
  dispose(): void;
}

let sequence = Date.now() * 1000;

function label(agents: HerdrSidebarAgent[]): string {
  const names = [...new Set(agents.map((item) => item.agent))];
  const who = names.length ? ` · ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}` : "";
  return `● ${agents.length} agent${agents.length === 1 ? "" : "s"} active${who}`;
}

export function registerHerdrSidebar(options: HerdrSidebarOptions): HerdrSidebar {
  const env = options.env ?? process.env;
  const paneId = env.HERDR_PANE_ID;
  const enabled = env.HERDR_ENV === "1" && Boolean(paneId);
  const pollMs = options.pollMs ?? 500;
  const ttlMs = options.ttlMs ?? 120_000;
  const refreshMs = options.refreshMs ?? 45_000;
  let rootSession = false;
  let published = false;
  let busyLabel: string | undefined;
  let lastSignature = "";
  let lastPublishedAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: readonly string[] | undefined;
  let draining = false;
  let drainPromise = Promise.resolve();

  const enqueue = (args: readonly string[]): void => {
    pending = args;
    if (draining) return;
    draining = true;
    drainPromise = (async () => {
      while (pending) {
        const next = pending;
        pending = undefined;
        try { await options.runHerdr(next); } catch {}
      }
    })().finally(() => { draining = false; });
  };

  const clear = (): void => {
    if (!published || !paneId) return;
    published = false;
    lastSignature = "";
    lastPublishedAt = Date.now();
    enqueue(["pane", "report-metadata", paneId, "--source", SOURCE, "--agent", "pi", "--applies-to-source", "herdr:pi", "--clear-state-labels", "--clear-token", "summary", "--seq", String(++sequence)]);
  };

  const refresh = (): void => {
    if (!enabled || !rootSession || !paneId) return;
    let agents: HerdrSidebarAgent[];
    try {
      agents = [...options.getAgents()].filter((item) => item.id && item.agent && ACTIVE_STATUSES.has(item.status));
    } catch {
      return;
    }
    const signature = agents.map((item) => `${item.id}:${item.agent}:${item.status}`).sort().join("\0");
    if (!agents.length) {
      if (busyLabel) options.events.emit("herdr:busy", { active: false });
      busyLabel = undefined;
      clear();
      return;
    }
    const text = label(agents);
    if (busyLabel !== text) {
      if (busyLabel) options.events.emit("herdr:busy", { active: false });
      busyLabel = text;
      options.events.emit("herdr:busy", { active: true, label: text });
    }
    const now = Date.now();
    if (signature === lastSignature && now - lastPublishedAt < refreshMs) return;
    published = true;
    lastSignature = signature;
    lastPublishedAt = now;
    enqueue([
      "pane", "report-metadata", paneId,
      "--source", SOURCE,
      "--agent", "pi",
      "--applies-to-source", "herdr:pi",
      "--state-label", `idle=${text}`,
      "--state-label", `done=${text}`,
      "--state-label", `working=${text}`,
      "--token", `summary=${text}`,
      "--ttl-ms", String(ttlMs),
      "--seq", String(++sequence),
    ]);
  };

  return {
    sessionStarted(hasUI) {
      if (!enabled || !hasUI) return;
      rootSession = true;
      refresh();
      if (pollMs > 0 && !timer) {
        timer = setInterval(refresh, pollMs);
        timer.unref?.();
      }
    },
    refresh,
    async flush() {
      while (draining || pending) await drainPromise;
    },
    dispose() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (busyLabel) options.events.emit("herdr:busy", { active: false });
      busyLabel = undefined;
      clear();
      rootSession = false;
    },
  };
}
