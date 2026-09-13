import { BaseCheckpointSaver, WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';
import { db } from './storage.js';

/** SQLite persistence using LangGraph's serializer, including pending parallel writes. */
export class SqliteCheckpointer extends BaseCheckpointSaver {
  async getTuple(config) {
    const c = config.configurable || {};
    const args = [c.thread_id, c.checkpoint_ns || ''];
    const row = c.checkpoint_id
      ? db.prepare('SELECT * FROM checkpoints WHERE thread=? AND ns=? AND id=?').get(...args, c.checkpoint_id)
      : db.prepare('SELECT * FROM checkpoints WHERE thread=? AND ns=? ORDER BY id DESC LIMIT 1').get(...args);
    if (!row) return undefined;
    const tuple = {
      config: { configurable: { thread_id: row.thread, checkpoint_ns: row.ns, checkpoint_id: row.id } },
      checkpoint: await this.serde.loadsTyped(row.type, row.value),
      metadata: await this.serde.loadsTyped(row.metadata_type, row.metadata),
      pendingWrites: await Promise.all(db.prepare('SELECT * FROM checkpoint_writes WHERE thread=? AND ns=? AND checkpoint=? ORDER BY task,idx').all(row.thread, row.ns, row.id)
        .map(async w => [w.task, w.channel, await this.serde.loadsTyped(w.type, w.value)])),
    };
    if (row.parent) tuple.parentConfig = { configurable: { thread_id: row.thread, checkpoint_ns: row.ns, checkpoint_id: row.parent } };
    return tuple;
  }
  async *list(config, options = {}) {
    const c = config?.configurable || {};
    let remaining = options.limit ?? Infinity;
    const where = [], params = [];
    if (c.thread_id) { where.push('thread=?'); params.push(c.thread_id); }
    if (c.checkpoint_ns !== undefined) { where.push('ns=?'); params.push(c.checkpoint_ns); }
    if (c.checkpoint_id) { where.push('id=?'); params.push(c.checkpoint_id); }
    if (options.before?.configurable?.checkpoint_id) { where.push('id<?'); params.push(options.before.configurable.checkpoint_id); }
    const rows = db.prepare(`SELECT thread,ns,id FROM checkpoints${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`).all(...params);
    for (const row of rows) {
      if (remaining <= 0) break;
      if (c.thread_id && row.thread !== c.thread_id) continue;
      if (c.checkpoint_ns !== undefined && row.ns !== c.checkpoint_ns) continue;
      if (c.checkpoint_id && row.id !== c.checkpoint_id) continue;
      if (options.before?.configurable?.checkpoint_id && row.id >= options.before.configurable.checkpoint_id) continue;
      const tuple = await this.getTuple({ configurable: { thread_id: row.thread, checkpoint_ns: row.ns, checkpoint_id: row.id } });
      if (options.filter && !Object.entries(options.filter).every(([k,v]) => JSON.stringify(tuple.metadata?.[k]) === JSON.stringify(v))) continue;
      remaining--;
      yield tuple;
    }
  }
  count(threadId, namespace = '') {
    return db.prepare('SELECT COUNT(*) AS count FROM checkpoints WHERE thread=? AND ns=?').get(threadId, namespace).count;
  }
  async put(config, checkpoint, metadata) {
    const c = config.configurable;
    if (!c?.thread_id) throw new Error('checkpoint requires thread_id');
    const [type,value] = await this.serde.dumpsTyped(checkpoint);
    const [mt,mv] = await this.serde.dumpsTyped(metadata);
    db.prepare('INSERT OR REPLACE INTO checkpoints VALUES (?,?,?,?,?,?,?,?)').run(c.thread_id,c.checkpoint_ns || '',checkpoint.id,c.checkpoint_id || null,type,value,mt,mv);
    return { configurable: { thread_id: c.thread_id, checkpoint_ns: c.checkpoint_ns || '', checkpoint_id: checkpoint.id } };
  }
  async putWrites(config, writes, taskId) {
    const c = config.configurable;
    const encoded = await Promise.all(writes.map(async ([channel,value],i) => {
      const [type,data] = await this.serde.dumpsTyped(value);
      return [c.thread_id,c.checkpoint_ns || '',c.checkpoint_id,taskId,WRITES_IDX_MAP[channel] ?? i,channel,type,data];
    }));
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of encoded) db.prepare(`INSERT OR ${row[4] < 0 ? 'REPLACE' : 'IGNORE'} INTO checkpoint_writes VALUES (?,?,?,?,?,?,?,?)`).run(...row);
      db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK'); throw e; }
  }
  async deleteThread(threadId) {
    db.prepare('DELETE FROM checkpoints WHERE thread=?').run(threadId);
    db.prepare('DELETE FROM checkpoint_writes WHERE thread=?').run(threadId);
  }
}
export const checkpointer = new SqliteCheckpointer();
