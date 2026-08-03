import { Type } from "typebox";

export const MeshTaskSchema = Type.Object({
  id: Type.Optional(Type.String({ maxLength: 64, description: "Stable node ID used by dependsOn." })),
  agent: Type.String({ minLength: 1, maxLength: 128, description: "Agent name returned by list_agents." }),
  task: Type.String({ minLength: 1, maxLength: 65536, description: "Self-contained assignment for the child agent." }),
  dependsOn: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 64, description: "Node IDs that must succeed before this node starts." })),
  cwd: Type.Optional(Type.String({ maxLength: 4096, description: "Working directory inside the trusted run root." })),
  model: Type.Optional(Type.String({ maxLength: 256, description: "Optional provider/model override for this node." })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 3_600_000, description: "Attempt timeout in milliseconds." })),
  retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Retries after a failed attempt." })),
  integration: Type.Optional(Type.Boolean({ description: "Required for a node that explicitly integrates multiple writer predecessors." })),
}, { additionalProperties: false });
