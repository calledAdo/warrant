// H-MEM reference implementation facade. Deterministic, zero runtime
// dependencies, in-memory with optional JSON persistence. This is the
// minimal runnable expression of AGENTS.md, not a production library.
import { MemoryStoreService } from "./memoryStore.js";
import { TrustLedgerService } from "./trustLedger.js";
import { MemoryMiningService } from "./memoryMining.js";
import { MemoryRetrievalService } from "./memoryRetrieval.js";
import { ConflictDetectionService } from "./conflictDetection.js";
import { SleepCycleService } from "./sleepCycle.js";
import { DreamingService } from "./dreaming.js";
export * from "./types.js";
export { MemoryStoreService } from "./memoryStore.js";
export { TrustLedgerService } from "./trustLedger.js";
export { MemoryMiningService, parseStrictJsonArray } from "./memoryMining.js";
export { MemoryRetrievalService } from "./memoryRetrieval.js";
export { ConflictDetectionService } from "./conflictDetection.js";
export { SleepCycleService } from "./sleepCycle.js";
export { DreamingService } from "./dreaming.js";
export { embed, cosine, tokenize, jaccard } from "./embeddings.js";
export class HMEM {
    ledger;
    store;
    mining;
    retrieval;
    conflicts;
    sleep;
    dreaming;
    clock;
    constructor(opts = {}) {
        this.clock = opts.clock ?? Date.now;
        const actor = opts.actor ?? "system";
        this.ledger = new TrustLedgerService(this.clock, opts.persistDir);
        this.store = new MemoryStoreService(this.clock, this.ledger, actor, opts.persistDir);
        this.mining = new MemoryMiningService(this.store, this.clock, opts.minerFn);
        this.retrieval = new MemoryRetrievalService(this.store, this.ledger, this.clock, actor);
        this.conflicts = new ConflictDetectionService(this.store, this.ledger, this.clock, actor);
        this.sleep = new SleepCycleService(this.store, this.ledger, this.clock, actor);
        this.dreaming = new DreamingService(this.store, this.ledger, this.clock, actor);
    }
    // Convenience surface mirroring HOW_TO_USE_H-MEM.md.
    add(input) {
        return this.store.add(input);
    }
    mine(event, text, opts) {
        return this.mining.mineInteraction(event, text, opts);
    }
    query(query, opts) {
        return this.retrieval.query(query, opts);
    }
    feedback(memoryId, kind) {
        this.retrieval.feedback(memoryId, kind);
    }
}
