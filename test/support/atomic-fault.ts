import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

/** Real rename, then one directory fsync failure, before the writer returns. */
export function failDirectorySync(select: (file: string) => boolean) {
  const rename = fs.renameSync, sync = fs.fsyncSync;
  let armed = false, hits = 0;
  fs.renameSync = ((from: any, to: any) => { rename(from, to); if (!hits && select(String(to))) armed = true; }) as typeof fs.renameSync;
  fs.fsyncSync = (fd) => { if (armed && fs.fstatSync(fd).isDirectory()) { armed = false; hits++; throw new Error("injected directory fsync after real rename"); } sync(fd); };
  syncBuiltinESMExports();
  return { get hits() { return hits; }, restore() { fs.renameSync = rename; fs.fsyncSync = sync; syncBuiltinESMExports(); } };
}

/** Multi-recipient real rename faults; unknown visibility fails exactly the two
 * post-failure verification reads, not subsequent mailbox scans. */
export function mixedMessageFault(warning = "mixed fsync fault") {
  const rename = fs.renameSync, sync = fs.fsyncSync, read = fs.readFileSync;
  let armed = "", unknownFile = "", unreadable = 0, hits = 0;
  fs.renameSync = ((from: any, to: any) => {
    rename(from, to);
    if (!String(to).includes("/messages/") || !String(to).endsWith(".json")) return;
    const message = JSON.parse(read(to, "utf8"));
    if (message.to === "a" || message.to === "b") { armed = String(to); if (message.to === "b") unknownFile = String(to); }
  }) as typeof fs.renameSync;
  fs.fsyncSync = fd => { if (armed && fs.fstatSync(fd).isDirectory()) { if (armed === unknownFile) unreadable = 2; armed = ""; hits++; throw new Error(warning); } sync(fd); };
  fs.readFileSync = ((file: any, ...args: any[]) => { if (String(file) === unknownFile && unreadable > 0) { unreadable--; throw new Error("visibility unavailable"); } return (read as any)(file, ...args); }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  return { get hits() { return hits; }, get unreadable() { return unreadable; }, restore() { fs.renameSync = rename; fs.fsyncSync = sync; fs.readFileSync = read; syncBuiltinESMExports(); } };
}
