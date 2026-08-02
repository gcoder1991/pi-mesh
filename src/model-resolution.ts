import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

function normalize(value: string): string { return value.toLowerCase().replace(/[._]/g, "-").replace(/-\d{8}$/, ""); }
export function resolveAgentModel(input: string | undefined, registry: ModelRegistry): string | undefined {
  if (!input) return undefined;
  const slash = input.indexOf("/");
  const provider = slash >= 0 ? input.slice(0, slash) : undefined;
  const model = slash >= 0 ? input.slice(slash + 1) : input;
  const available = registry.getAvailable();
  const exact = available.find((item) => (!provider || item.provider === provider) && item.id === model);
  if (exact) return `${exact.provider}/${exact.id}`;
  const target = normalize(model);
  const matches = available.filter((item) => (!provider || item.provider === provider) && (normalize(item.id) === target || normalize(item.name).includes(target) || normalize(item.id).includes(target)));
  if (matches.length === 1) return `${matches[0]!.provider}/${matches[0]!.id}`;
  if (provider) {
    const cross = available.filter((item) => normalize(item.id) === target);
    if (cross.length === 1) return `${cross[0]!.provider}/${cross[0]!.id}`;
  }
  throw new Error(`Model is unavailable or ambiguous: ${input}`);
}
