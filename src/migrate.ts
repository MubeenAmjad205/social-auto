/**
 * src/migrate.ts — run once at setup to create indexes.
 *
 *   wrangler dev src/migrate.ts   (then hit it once)
 * or paste the index commands into the Atlas UI / mongosh.
 *
 * The unique index on idempotency_key is load-bearing: it is the last line of
 * defence against a timed-out-but-successful publish being retried into a
 * duplicate post.
 */

import { MongoClient } from 'mongodb';

export interface Env { MONGODB_URI: string; MONGODB_DB: string }

export default {
  async fetch(_r: Request, env: Env): Promise<Response> {
    const client = new MongoClient(env.MONGODB_URI, { maxPoolSize: 1 });
    await client.connect();
    const db = client.db(env.MONGODB_DB);

    await db.collection('drafts').createIndex({ platform: 1, status: 1, created_at: 1 });
    await db.collection('drafts').createIndex({ idempotency_key: 1 }, { unique: true });
    await db.collection('seeds').createIndex({ used_at: 1, kind: 1, created_at: 1 });
    await db.collection('style_refs').createIndex({ active: 1 });
    await db.collection('posts').createIndex({ published_at: -1 });
    await db.collection('sources_seen').createIndex({ first_seen: 1 });
    // 180-day TTL — debugging history goes stale.
    await db.collection('runs').createIndex({ started_at: 1 }, { expireAfterSeconds: 15_552_000 });

    await client.close();
    return new Response('indexes created');
  },
};
