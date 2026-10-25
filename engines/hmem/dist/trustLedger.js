// Append-only trust ledger (AGENTS.md section 9.1). Entries are never
// mutated or deleted. history() reconstructs a memory's full change record
// from the previousState/newState snapshots carried on each entry.
import fs from "node:fs";
import path from "node:path";
export class TrustLedgerService {
    clock;
    entries = [];
    file;
    constructor(clock, persistDir) {
        this.clock = clock;
        if (persistDir) {
            this.file = path.join(persistDir, "ledger.jsonl");
            if (fs.existsSync(this.file)) {
                // Warrant (October 2026): tolerate a torn final line the same way the
                // store events log does (crash mid-append). Earlier complete lines are
                // always accepted; only the tail is at risk and never read twice.
                const raw = fs.readFileSync(this.file, "utf-8");
                const lines = raw.split("\n").filter(Boolean);
                let completeBytes = 0;
                entryParsing: for (const line of lines) {
                    try {
                        this.entries.push(JSON.parse(line));
                    }
                    catch {
                        // Torn tail (crash mid-append): keep earlier complete entries and
                        // truncate the incomplete bytes so later appends stay contiguous.
                        break entryParsing;
                    }
                    completeBytes += Buffer.byteLength(line, "utf-8") + 1;
                }
                if (lines.length > 0 && completeBytes !== Buffer.byteLength(raw, "utf-8")) {
                    fs.writeFileSync(this.file, raw.slice(0, completeBytes), "utf-8");
                }
            }
        }
    }
    log(memoryId, action, actor, extra) {
        const entry = { memoryId, action, actor, timestamp: this.clock(), ...extra };
        this.entries.push(entry);
        if (this.file)
            fs.appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf-8");
        return entry;
    }
    history(memoryId) {
        return this.entries.filter((e) => e.memoryId === memoryId);
    }
    all() {
        return this.entries;
    }
    stats() {
        const out = {};
        for (const e of this.entries)
            out[e.action] = (out[e.action] ?? 0) + 1;
        return out;
    }
}
