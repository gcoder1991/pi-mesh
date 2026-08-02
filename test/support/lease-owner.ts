import { acquireRunLease } from "../../src/run-lease.ts";

const [cwd, runId, hold = "0"] = process.argv.slice(2);
try {
  const lease = acquireRunLease(cwd, runId);
  process.stdout.write("acquired\n");
  setTimeout(() => { lease.release(); process.exit(0); }, Number(hold));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
