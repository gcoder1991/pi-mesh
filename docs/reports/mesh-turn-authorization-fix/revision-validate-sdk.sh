#!/bin/bash
# Isolated SOURCE snapshot with existing dependencies, never npm install or edits
# to either repository's installed node_modules. Needed for the pre-existing
# bridge harness's strict SDK package-identity assertion (see initial-sdk-barrier.txt).
set -eu
MESH=$(cd "$(dirname "$0")/../../.." && pwd)
CROSS=${1:-/Users/relvf/ai/pi-cross-session}
SNAPSHOT=$(mktemp -d /tmp/mesh-continuation-review.XXXXXX)
trap 'rm -rf "$SNAPSHOT"' EXIT
cp -R "$MESH/src" "$MESH/test" "$MESH/agents" "$MESH/workflows" "$MESH/index.ts" "$MESH/package.json" "$SNAPSHOT/"
node --input-type=module - "$MESH" "$SNAPSHOT" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [mesh, snapshot] = process.argv.slice(2);
const deps = path.join(mesh, 'node_modules');
for (const entry of fs.readdirSync(deps).filter(n => !n.startsWith('.'))) {
  const names = entry.startsWith('@') ? fs.readdirSync(path.join(deps, entry)).map(n => `${entry}/${n}`) : [entry];
  for (const name of names) {
    const source = ['@earendil-works/pi-ai', '@earendil-works/pi-tui'].includes(name)
      ? path.join(deps, '@earendil-works/pi-coding-agent/node_modules', name) : path.join(deps, name);
    const target = path.join(snapshot, 'node_modules', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(fs.realpathSync(source), target, 'dir');
  }
}
const hashes = {};
for (const relative of ['src/extension.ts', 'src/continuation.ts', 'src/notifications.ts', 'test/bridge/run.mjs']) {
  const bytes = fs.readFileSync(path.join(mesh, relative));
  if (!bytes.equals(fs.readFileSync(path.join(snapshot, relative)))) throw new Error(`Snapshot mismatch: ${relative}`);
  hashes[relative] = createHash('sha256').update(bytes).digest('hex');
}
console.log('MESH_SNAPSHOT', JSON.stringify({ mesh, snapshot, hashes }));
JS
cd "$SNAPSHOT"
node --import ./test/support/clean-env.mjs --experimental-strip-types --test-name-pattern='continuation actual SDK' test/bridge/run.mjs --cross-source "$CROSS"
