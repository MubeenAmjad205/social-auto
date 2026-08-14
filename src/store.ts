/**
 * src/store.ts
 *
 * The only data layer. Everything goes through the Store interface so that if
 * spike/atlas-check.ts shows the Atlas hot path is too slow or too CPU-hungry,
 * swapping to the hybrid fallback (D1 for tokens+drafts, Atlas for the rest)
 * is one new file rather than a rewrite.
 *
 * Token encryption happens INSIDE getToken/saveToken and nowhere else, so it
 * cannot be forgotten at a call site.
 */

import { MongoClient, Db } from 'mongodb';
import { seal, open, Sealed } from './secrets';

export type Platform = 'linkedin' | 'instagram';
export type Status = 'pending' | 'approved' | 'rejected' | 'published' | 'failed';
export type SeedKind = 'own' | 'client';

export interface Fact {
  claim: string;
  source_name: string;
  url: string;
  published_at: string;
  snippet: string;
}

export interface Seed {
  _id: string;
  note: string;
  angle?: string;
  kind: SeedKind;
}

export interface Draft {
  _id: string;
  platform: Platform;
  status: Status;
  body: string;
  image_key: string | null;       // LinkedIn's single image; Instagram's cover slide
  image_keys: string[] | null;    // Instagram carousel: every slide, in order. null for LinkedIn.
  image_prompt: string;
  seed: Seed;
  facts: Fact[];
  editor_flags: string[];
  attempts: number;
  last_error: string | null;
  remote_id: string | null;
  idempotency_key: string;
  created_at: Date;
  published_at: Date | null;
}

export interface PlainToken {
  access_token: string;
  expires_at: Date;
  member_urn?: string;
}

export interface DecryptedToken extends PlainToken {
  updated_at: Date;
}

export interface Store {
  getToken(p: Platform): Promise<DecryptedToken | null>;
  saveToken(p: Platform, t: PlainToken): Promise<void>;

  createDraft(d: Omit<Draft, '_id' | 'created_at' | 'published_at'>): Promise<string>;
  getDraft(id: string): Promise<Draft | null>;
  setStatus(id: string, s: Status, patch?: Partial<Draft>): Promise<void>;
  dueFor(p: Platform, limit: number): Promise<Draft[]>;

  nextSeed(preferKind?: SeedKind): Promise<Seed | null>;
  addSeed(note: string, kind: SeedKind, angle?: string): Promise<void>;
  markSeedUsed(id: string): Promise<void>;
  seedCount(): Promise<number>;

  activeStyleRefs(): Promise<string[]>;

  logRun(r: unknown): Promise<void>;
  recordPost(p: unknown): Promise<void>;
  seenSource(url: string): Promise<boolean>;
  markSourceSeen(s: { url: string; title: string; source_name: string }): Promise<void>;

  close(): Promise<void>;
}

export class MongoStore implements Store {
  private client: MongoClient;
  private db!: Db;
  private connected = false;

  constructor(private uri: string, private dbName: string, private tokenKey: string) {
    if (uri.startsWith('mongodb+srv://')) {
      // Fail loudly and immediately rather than with an opaque DNS error
      // twenty minutes into debugging.
      throw new Error('SRV connection string — workerd cannot resolve it. Use the legacy multi-host form.');
    }
    this.client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
      maxPoolSize: 1, // ephemeral isolate; nothing to pool across invocations
    });
  }

  private async conn(): Promise<Db> {
    if (!this.connected) {
      await this.client.connect();
      this.db = this.client.db(this.dbName);
      this.connected = true;
    }
    return this.db;
  }

  async close() {
    if (this.connected) await this.client.close();
  }

  // ------------------------------------------------------------- tokens
  // Plaintext tokens exist only inside these two methods and the outbound
  // Authorization header. Never logged, never returned in an error.

  async getToken(p: Platform): Promise<DecryptedToken | null> {
    const db = await this.conn();
    const doc = await db.collection('tokens').findOne({ _id: p as any });
    if (!doc) return null;

    const access_token = await open({ ct: doc.ct, iv: doc.iv } as Sealed, this.tokenKey);
    return {
      access_token,
      expires_at: doc.expires_at,
      member_urn: doc.member_urn,
      updated_at: doc.updated_at,
    };
  }

  async saveToken(p: Platform, t: PlainToken): Promise<void> {
    const db = await this.conn();
    const sealed = await seal(t.access_token, this.tokenKey);
    await db.collection('tokens').updateOne(
      { _id: p as any },
      {
        $set: {
          ct: sealed.ct,
          iv: sealed.iv,
          expires_at: t.expires_at,
          member_urn: t.member_urn ?? null,
          updated_at: new Date(),
        },
      },
      { upsert: true }
    );
  }

  // ------------------------------------------------------------- drafts

  async createDraft(d: Omit<Draft, '_id' | 'created_at' | 'published_at'>): Promise<string> {
    const db = await this.conn();
    const _id = crypto.randomUUID();
    await db.collection('drafts').insertOne({
      _id: _id as any,
      ...d,
      created_at: new Date(),
      published_at: null,
    });
    return _id;
  }

  async getDraft(id: string): Promise<Draft | null> {
    const db = await this.conn();
    return db.collection('drafts').findOne({ _id: id as any }) as unknown as Promise<Draft | null>;
  }

  async setStatus(id: string, s: Status, patch: Partial<Draft> = {}): Promise<void> {
    const db = await this.conn();
    await db.collection('drafts').updateOne(
      { _id: id as any },
      { $set: { status: s, ...patch } }
    );
  }

  async dueFor(p: Platform, limit: number): Promise<Draft[]> {
    const db = await this.conn();
    return db.collection('drafts')
      .find({ platform: p, status: 'approved', attempts: { $lt: 3 } })
      .sort({ created_at: 1 })
      .limit(limit)
      .toArray() as unknown as Promise<Draft[]>;
  }

  // -------------------------------------------------------------- seeds

  /**
   * Roughly 2:1 own-work to client-work, per docs/03. Try the preferred kind
   * first, fall back to anything rather than skipping a day.
   */
  async nextSeed(preferKind?: SeedKind): Promise<Seed | null> {
    const db = await this.conn();
    const find = (q: object) =>
      db.collection('seeds').findOne(q as any, { sort: { created_at: 1 } });

    const doc =
      (preferKind && (await find({ used_at: null, kind: preferKind }))) ||
      (await find({ used_at: null }));

    if (!doc) return null;
    return { _id: String(doc._id), note: doc.note, angle: doc.angle, kind: doc.kind };
  }

  async addSeed(note: string, kind: SeedKind, angle?: string): Promise<void> {
    const db = await this.conn();
    await db.collection('seeds').insertOne({
      note, kind, angle: angle ?? null, used_at: null, created_at: new Date(),
    });
  }

  async markSeedUsed(id: string): Promise<void> {
    const db = await this.conn();
    const { ObjectId } = await import('mongodb');
    await db.collection('seeds').updateOne(
      { _id: new ObjectId(id) },
      { $set: { used_at: new Date() } }
    );
  }

  async seedCount(): Promise<number> {
    const db = await this.conn();
    return db.collection('seeds').countDocuments({ used_at: null });
  }

  // -------------------------------------------------------------- style

  async activeStyleRefs(): Promise<string[]> {
    const db = await this.conn();
    const docs = await db.collection('style_refs')
      .find({ active: true }).limit(3).toArray();
    return docs.map(d => d.image_key);
  }

  // ------------------------------------------------------------ archive
  // Always invoked via ctx.waitUntil(). Never awaited on the critical path —
  // a logging failure must not take down a publish.

  async logRun(r: unknown): Promise<void> {
    const db = await this.conn();
    await db.collection('runs').insertOne(r as any);
  }

  async recordPost(p: unknown): Promise<void> {
    const db = await this.conn();
    await db.collection('posts').insertOne(p as any);
  }

  async seenSource(url: string): Promise<boolean> {
    const db = await this.conn();
    const id = await sha256(url);
    return !!(await db.collection('sources_seen').findOne({ _id: id as any }));
  }

  async markSourceSeen(s: { url: string; title: string; source_name: string }): Promise<void> {
    const db = await this.conn();
    const id = await sha256(s.url);
    await db.collection('sources_seen').updateOne(
      { _id: id as any },
      { $set: { ...s }, $setOnInsert: { first_seen: new Date() }, $inc: { times_used: 1 } },
      { upsert: true }
    );
  }
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
