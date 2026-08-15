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

export type Platform = 'linkedin' | 'instagram' | 'bluesky' | 'threads' | 'mastodon';
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
  // Despite the field name, these are public URLs (Cloudinary-hosted — see
  // src/cloudinary-storage.ts), not object-storage keys. Named before R2 was
  // replaced; kept for schema stability rather than a cosmetic rename.
  image_key: string | null;       // the shared image (LinkedIn/Bluesky/Threads/Mastodon); Instagram's cover slide
  image_keys: string[] | null;    // Instagram carousel: every slide's URL, in order. null for non-carousel drafts.
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
  listActive(limit: number): Promise<Draft[]>;

  // Claiming a seed and marking it used are the same atomic operation — see
  // the comment on MongoStore.nextSeed. returnSeed undoes that claim when
  // the draft it produced didn't survive (rejected, or generation failed).
  nextSeed(preferKind?: SeedKind): Promise<Seed | null>;
  returnSeed(id: string): Promise<void>;
  addSeed(note: string, kind: SeedKind, angle?: string): Promise<void>;
  seedCount(): Promise<number>;

  activeStyleRefs(): Promise<string[]>;
  addStyleRef(imageKey: string): Promise<void>;

  // Cooldown for manually-triggered pipeline stages (src/index.ts's runStage,
  // shared by the /run/* HTTP routes and the Telegram command center) — a
  // leaked WEBHOOK_SECRET or an over-eager finger shouldn't be able to spam
  // real LLM/image-gen calls or real publishes. Returns true (and claims the
  // slot) if `key` hasn't fired within `minIntervalMs`, false otherwise.
  claimRateLimit(key: string, minIntervalMs: number): Promise<boolean>;

  logRun(r: unknown): Promise<void>;
  lastRun(): Promise<any | null>;
  recordPost(p: unknown): Promise<void>;
  listPosts(limit: number): Promise<any[]>;
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
    if (!this.connected) return;
    try {
      await this.client.close();
    } catch (err) {
      // A close failure must never override an already-decided response —
      // every caller does `try { ...; return X } finally { await store.close() }`,
      // and an exception thrown IN a finally block replaces whatever the try
      // block already returned. workerd's socket layer can drop an idle
      // connection out from under the driver (surfacing as
      // MongoTopologyClosedError on the next close()) — that's a harmless
      // double-close, not a real failure, so it's swallowed here once rather
      // than requiring every call site to remember to .catch() its finally.
      console.error('MongoStore.close() failed (non-fatal):', err);
    }
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

  async listActive(limit: number): Promise<Draft[]> {
    const db = await this.conn();
    return db.collection('drafts')
      .find({ status: { $in: ['pending', 'approved'] } })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray() as unknown as Promise<Draft[]>;
  }

  // -------------------------------------------------------------- seeds

  /**
   * Claim-and-use in one atomic findOneAndUpdate, not a separate read then a
   * later markSeedUsed(). Two reasons: (1) a read-then-write-later gap left a
   * window where two overlapping invocations could select the same unused
   * seed; (2) it lets returnSeed() below be the single, symmetric way a seed
   * goes back in the pool — on a rejected draft or a failed generation —
   * rather than tracking used/claimed as two different states.
   *
   * Roughly 2:1 own-work to client-work, per docs/03. Try the preferred kind
   * first, fall back to anything rather than skipping a day.
   */
  async nextSeed(preferKind?: SeedKind): Promise<Seed | null> {
    const db = await this.conn();
    const claim = (q: object) =>
      db.collection('seeds').findOneAndUpdate(
        q as any,
        { $set: { used_at: new Date() } },
        { sort: { created_at: 1 }, returnDocument: 'before' }
      );

    const doc =
      (preferKind && (await claim({ used_at: null, kind: preferKind }))) ||
      (await claim({ used_at: null }));

    if (!doc) return null;
    return { _id: String(doc._id), note: doc.note, angle: doc.angle, kind: doc.kind };
  }

  async returnSeed(id: string): Promise<void> {
    const db = await this.conn();
    const { ObjectId } = await import('mongodb');
    await db.collection('seeds').updateOne(
      { _id: new ObjectId(id) },
      { $set: { used_at: null } }
    );
  }

  async addSeed(note: string, kind: SeedKind, angle?: string): Promise<void> {
    const db = await this.conn();
    await db.collection('seeds').insertOne({
      note, kind, angle: angle ?? null, used_at: null, created_at: new Date(),
    });
  }

  async seedCount(): Promise<number> {
    const db = await this.conn();
    return db.collection('seeds').countDocuments({ used_at: null });
  }

  // -------------------------------------------------------------- style
  // image_key here is a public URL (Cloudinary-hosted), same as on Draft — see
  // the comment on Draft.image_key above.

  async activeStyleRefs(): Promise<string[]> {
    const db = await this.conn();
    const docs = await db.collection('style_refs')
      .find({ active: true }).limit(3).toArray();
    return docs.map(d => d.image_key);
  }

  /**
   * Max 3 active per docs/05 — FLUX.2 klein accepts up to 4 reference images
   * but 3 keeps one slot of headroom. Adding a 4th deactivates the oldest
   * rather than rejecting the call, so this is safe to expose as a one-tap
   * Telegram action without a separate "which one to drop" decision.
   */
  async addStyleRef(imageKey: string): Promise<void> {
    const db = await this.conn();
    await db.collection('style_refs').insertOne({ image_key: imageKey, active: true, created_at: new Date() });

    const active = await db.collection('style_refs')
      .find({ active: true }).sort({ created_at: 1 }).toArray();
    if (active.length > 3) {
      const toRetire = active.slice(0, active.length - 3).map(d => d._id);
      await db.collection('style_refs').updateMany({ _id: { $in: toRetire } }, { $set: { active: false } });
    }
  }

  // ------------------------------------------------------------ archive
  // Always invoked via ctx.waitUntil(). Never awaited on the critical path —
  // a logging failure must not take down a publish.

  async logRun(r: unknown): Promise<void> {
    const db = await this.conn();
    await db.collection('runs').insertOne(r as any);
  }

  async lastRun(): Promise<any | null> {
    const db = await this.conn();
    return db.collection('runs').findOne({}, { sort: { started_at: -1 } });
  }

  async recordPost(p: unknown): Promise<void> {
    const db = await this.conn();
    await db.collection('posts').insertOne(p as any);
  }

  async listPosts(limit: number): Promise<any[]> {
    const db = await this.conn();
    return db.collection('posts').find({}).sort({ published_at: -1 }).limit(limit).toArray();
  }

  // Deliberately NOT atomic (read, then write) — a coordinated race landing
  // two requests in the same few-millisecond gap would let both through once.
  // That's an acceptable trade for a solo-operator debug/ops tool; the thing
  // actually worth blocking is repeated hammering over seconds/minutes, which
  // this does correctly. A findOneAndUpdate with a $lt filter would close
  // that gap but has its own upsert/duplicate-key hazard against an existing
  // recent document — not worth the complexity here.
  async claimRateLimit(key: string, minIntervalMs: number): Promise<boolean> {
    const db = await this.conn();
    const doc = await db.collection('rate_limits').findOne({ _id: key as any });
    const now = new Date();
    if (doc?.last_at && now.getTime() - new Date(doc.last_at).getTime() < minIntervalMs) {
      return false;
    }
    await db.collection('rate_limits').updateOne(
      { _id: key as any },
      { $set: { last_at: now } },
      { upsert: true }
    );
    return true;
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
