import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

// Network/IPC only: inherited by derived Node/Pi processes without scrubbing
// fixture protocol parameters. clean-env owns and removes the private root.
const noNetwork = () => { throw new Error("Test network access is disabled; use a local provider and private Unix socket fixtures"); };
globalThis.fetch = async () => noNetwork();
for (const module of [http, https]) for (const name of ["request", "get"]) module[name] = noNetwork;
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "reverse"]) {
  dns[name] = noNetwork;
  dns.promises[name] = async () => noNetwork();
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  const file = typeof options === "string" ? options : options?.path;
  if (typeof file !== "string") return noNetwork();
  const root = process.env.PI_MESH_TEST_PRIVATE_ROOT;
  if (!root || !/^pm-test-/.test(path.basename(root))) return noNetwork();
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const inRoot = (target) => { const relative = path.relative(root, target); return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  // Actual Cross uses a short /tmp namespace derived from this private agentDir.
  // Permit ONLY this fixture's exact namespace, never other user/fixture peers.
  const crossDir = agentDir && inRoot(path.resolve(agentDir)) ? path.join(fs.realpathSync("/tmp"), `pi-peers-${process.getuid?.() ?? 0}-${createHash("sha256").update(agentDir).digest("hex").slice(0, 12)}`) : undefined;
  const inside = target => inRoot(target) || (crossDir && path.dirname(target) === crossDir && /^[0-9a-f]{32}\.sock$/.test(path.basename(target)));
  // /tmp is an alias for /private/tmp on macOS; canonicalize the parent before admission.
  const canonical = target => { try { return path.join(fs.realpathSync(path.dirname(target)), path.basename(target)); } catch { return path.resolve(target); } };
  if (!inside(canonical(file))) return noNetwork();
  try { if (!inside(fs.realpathSync(file))) return noNetwork(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return connect.apply(this, args);
};
syncBuiltinESMExports();
