// Acquisition pipeline (AGENTS.md section 4). The model-free fallback path is
// the DEFAULT: heuristic sentence extraction preserves capture continuity with
// no model available. An optional minerFn hook accepts an extraction prompt
// and returns a strict JSON array of memory strings; its output is parsed
// robustly (markdown fences stripped, format noise tolerated).
const EVENT_TYPE_MAP = {
    chat_message: "general",
    user_correction: "preference",
    file_save: "factual",
    file_open: "general",
    file_edit: "factual",
    model_response: "factual",
    plan_completion: "factual",
};
const SIGNAL = /\b(prefer|always|never|decided|chose|choose|use|because|instead|must|should|important|remember)\b/i;
export class MemoryMiningService {
    store;
    clock;
    minerFn;
    constructor(store, clock, minerFn) {
        this.store = store;
        this.clock = clock;
        this.minerFn = minerFn;
    }
    async mineInteraction(event, text, opts) {
        const candidates = this.minerFn
            ? await this.mineWithModel(event, text)
            : this.mineModelFree(text);
        return candidates.map((content) => this.store.add({
            content,
            type: EVENT_TYPE_MAP[event],
            layer: opts?.layer ?? (this.minerFn ? "working" : "short_term"),
            tags: [`event:${event}`],
            source: `interaction:${event}`,
            provenance: { origin: event, learnedAt: this.clock(), label: `mined from ${event}` },
            chatId: opts?.chatId,
        }));
    }
    async mineDocument(fileName, text) {
        const truncated = text.slice(0, 8000); // safe token window
        const candidates = this.minerFn
            ? await this.mineWithModel("file_save", truncated)
            : this.mineModelFree(truncated);
        return candidates.map((content) => this.store.add({
            content,
            type: "factual",
            layer: "working",
            tags: ["document", `file:${fileName}`],
            source: `document:${fileName}`,
        }));
    }
    // 4.3: no-model fallback. Concise direct summaries as short-term memories.
    mineModelFree(text) {
        return text
            .split(/(?<=[.!?])\s+|\n+/)
            .map((s) => s.trim())
            .filter((s) => s.length >= 20 && s.length <= 300 && SIGNAL.test(s))
            .slice(0, 10);
    }
    async mineWithModel(event, text) {
        const prompt = `Extract durable memories from this ${event} as a strict JSON array of strings:\n\n${text}`;
        const rawResponse = await this.minerFn(prompt);
        return parseStrictJsonArray(rawResponse);
    }
}
// Robust parsing: strip markdown fences, tolerate minor noise (section 4.1 step 3).
export function parseStrictJsonArray(raw) {
    let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start !== -1 && end > start)
        cleaned = cleaned.slice(start, end + 1);
    try {
        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((x) => typeof x === "string" && x.trim().length >= 5);
    }
    catch {
        return [];
    }
}
