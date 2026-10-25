// Tiered memory store with enrichment (AGENTS.md sections 2, 3, 5).
// A record with no source is rejected by construction. Enrichment runs on
// every add: domain classification, namespace, entity extraction (cap 10),
// relatedTo discovery (cap 5, bidirectional), supersedes detection.
import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, clamp01 } from "./types.js";
import { cosine, embed, tokenize } from "./embeddings.js";
const TECH_TERMS = [
    "react", "python", "typescript", "javascript", "rust", "sqlite", "postgres", "indexeddb",
    "node", "docker", "graphql", "redis", "webrtc", "tauri", "electron", "llm", "embedding",
];
const DOMAIN_KEYWORDS = {
    tech: ["code", "bug", "api", "database", "deploy", "framework", "library", "server", ...TECH_TERMS],
    work: ["meeting", "deadline", "client", "project", "sprint", "review", "report"],
    personal: ["family", "hobby", "prefer", "like", "dislike", "morning", "evening"],
};
export class MemoryStoreService {
    clock;
    ledger;
    actor;
    records = new Map();
    seq = 0;
    eventsFile;
    constructor(clock, ledger, actor, persistDir) {
        this.clock = clock;
        this.ledger = ledger;
        this.actor = actor;
        if (persistDir) {
            fs.mkdirSync(persistDir, { recursive: true });
            this.eventsFile = path.join(persistDir, "events.jsonl");
            this.replayEvents();
        }
    }
    /**
     * Warrant (October 2026): persistence is an append-only JSON Lines event log
     * (events.jsonl), replacing the upstream rewrite-whole-file state.json. Each
     * event line carries the full ordered store snapshot after one mutating
     * operation, so replay reduces to the last complete line. Replay is
     * crash-tolerant: a torn final line (e.g. power loss mid-append) is dropped
     * and state falls back to the last successful operation. O_APPEND appends
     * keep existing lines untouched, so a torn write can never damage earlier
     * state. `logs()` exposes every accepted snapshot for the audit trail.
     */
    replayEvents() {
        if (!this.eventsFile || !fs.existsSync(this.eventsFile))
            return;
        const raw = fs.readFileSync(this.eventsFile, "utf-8");
        const lines = raw.split("\n").filter(Boolean);
        let applied = 0;
        let completeBytes = 0;
        for (const line of lines) {
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                // Torn final line from a crash mid-append: recover from the last
                // complete snapshot and truncate the tail, so the next append stays
                // contiguous and nothing remains wedged between older and newer
                // events (equal to dropping the failed operation entirely).
                break;
            }
            this.records = new Map(event.records.map((r) => [r.id, structuredClone(r)]));
            this.seq = event.seq;
            applied++;
            completeBytes += Buffer.byteLength(line, "utf-8") + 1;
        }
        if (completeBytes !== Buffer.byteLength(raw, "utf-8")) {
            fs.writeFileSync(this.eventsFile, raw.slice(0, completeBytes), "utf-8");
        }
        this.eventsReplayed = applied;
    }
    eventsReplayed = 0;
    /** The complete event history accepted from events.jsonl, for audits/tests. */
    logs() {
        return this.eventsReplayed;
    }
    persist() {
        if (!this.eventsFile)
            return;
        const records = [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id));
        // Single JSON.stringify can't tear in the middle of the line for readers
        // that stop after the first failed parse: JSON has explicit terminator
        // counts, so line parse failure == the last line only.
        fs.appendFileSync(this.eventsFile, JSON.stringify({ seq: this.seq, records }) + "\n", "utf-8");
    }
    add(input) {
        if (!input.source || input.source.trim() === "") {
            throw new Error("H-MEM: a memory record with no source must be rejected by construction (AGENTS.md section 2)");
        }
        const now = this.clock();
        const id = `mem-${++this.seq}`;
        const tags = [...(input.tags ?? [])];
        const domain = this.classifyDomain(input.content, tags, input.type ?? "general");
        const record = {
            id,
            content: input.content,
            type: input.type ?? "general",
            layer: input.layer ?? "working",
            timestamp: now,
            lastAccessed: now,
            accessCount: 0,
            tags,
            embedding: embed(input.content),
            confidence: clamp01(input.confidence ?? 0.7),
            source: input.source,
            provenance: input.provenance ?? { origin: "manual", learnedAt: now, label: input.source },
            chatId: input.chatId,
            missionId: input.missionId,
            goalRunId: input.goalRunId,
            domain,
            namespace: this.namespace(domain, input.type ?? "general"),
            entities: this.extractEntities(input.content),
            relatedTo: [],
            supersedes: input.supersedes,
            derivedFrom: input.derivedFrom,
        };
        this.discoverRelationships(record);
        this.records.set(id, record);
        this.ledger.log(id, "create", this.actor, { newState: snapshot(record) });
        this.persist();
        return record;
    }
    get(id) {
        return this.records.get(id);
    }
    all() {
        return [...this.records.values()];
    }
    update(id, patch) {
        const rec = this.mustGet(id);
        const prev = snapshot(rec);
        Object.assign(rec, patch);
        this.ledger.log(id, "update", this.actor, { previousState: prev, newState: snapshot(rec) });
        this.persist();
        return rec;
    }
    delete(id, reason) {
        const rec = this.mustGet(id);
        this.records.delete(id);
        this.ledger.log(id, "delete", this.actor, { previousState: snapshot(rec), details: { reason } });
        this.persist();
    }
    touch(id) {
        const rec = this.mustGet(id);
        rec.lastAccessed = this.clock();
        rec.accessCount += 1;
    }
    promote(id, layer) {
        const rec = this.mustGet(id);
        const prev = snapshot(rec);
        rec.layer = layer;
        this.ledger.log(id, "promote", this.actor, { previousState: prev, newState: snapshot(rec) });
        this.persist();
    }
    restoreAll(records, seq) {
        this.records = new Map(records.map((r) => [r.id, structuredClone(r)]));
        this.seq = seq;
        this.persist();
    }
    snapshotAll() {
        return { records: structuredClone([...this.records.values()]), seq: this.seq };
    }
    mustGet(id) {
        const rec = this.records.get(id);
        if (!rec)
            throw new Error(`H-MEM: unknown memory id ${id}`);
        return rec;
    }
    // Multi-pass domain classification (AGENTS.md section 5).
    classifyDomain(content, tags, type) {
        for (const t of tags) {
            if (t.startsWith("project:"))
                return t.slice("project:".length);
            if (t.startsWith("tech:"))
                return "tech";
        }
        const tokens = new Set(tokenize(content));
        let best = "general";
        let bestScore = 0;
        for (const [domain, kws] of Object.entries(DOMAIN_KEYWORDS)) {
            let score = kws.reduce((s, kw) => s + (tokens.has(kw) ? 1 : 0), 0);
            if (domain === "personal" && (type === "personal" || type === "preference"))
                score += 1;
            if (score > bestScore) {
                best = domain;
                bestScore = score;
            }
        }
        return bestScore > 0 ? best : "general";
    }
    namespace(domain, type) {
        const bucket = type === "preference" || type === "personal" ? "profile" : type === "factual" ? "facts" : "notes";
        return `${domain}/${bucket}`;
    }
    extractEntities(content) {
        const entities = new Set();
        for (const t of tokenize(content))
            if (TECH_TERMS.includes(t))
                entities.add(t);
        for (const m of content.matchAll(/\b([A-Z][a-zA-Z]{2,})\b/g)) {
            const norm = m[1].toLowerCase();
            if (!["the", "this", "that", "with"].includes(norm))
                entities.add(norm);
        }
        return [...entities].slice(0, DEFAULTS.entityCap);
    }
    discoverRelationships(record) {
        const CORRECTION = /\b(actually|instead|no longer|not anymore|changed to|correction)\b/i;
        for (const other of this.records.values()) {
            if (record.relatedTo.length >= DEFAULTS.relatedCap)
                break;
            const sharedEntities = other.entities.filter((e) => record.entities.includes(e));
            const sim = cosine(record.embedding, other.embedding);
            if (!record.supersedes && sim > 0.85 && CORRECTION.test(record.content)) {
                record.supersedes = other.id;
                continue;
            }
            if (sharedEntities.length >= 1 && other.domain === record.domain) {
                record.relatedTo.push(other.id);
                if (other.relatedTo.length < DEFAULTS.relatedCap && !other.relatedTo.includes(record.id)) {
                    other.relatedTo.push(record.id); // bidirectional link
                }
            }
        }
    }
}
export function snapshot(r) {
    const { embedding, ...rest } = structuredClone(r);
    return rest;
}
