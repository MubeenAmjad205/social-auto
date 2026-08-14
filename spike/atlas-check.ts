/**
 * spike/atlas-check.ts
 *
 * RUN THIS BEFORE WRITING ANYTHING ELSE.
 *
 * The all-Atlas decision rests on three unverified assumptions. This answers
 * all three in about an hour, and either unblocks the plan or kills it before
 * you have built on top of it.
 *
 *   1. Does the driver connect from workerd at all?
 *   2. How much of the 10ms CPU budget does a cold connect burn?
 *   3. Does the bundle fit under the free-plan 3MB Worker size limit?
 *
 * Deploy as a throwaway Worker. Do not put it in the real one.
 *
 * ---- spike/wrangler.jsonc ----
 * {
 *   "name": "atlas-spike",
 *   "main": "atlas-check.ts",
 *   "compatibility_date": "2026-08-01",
 *   "compatibility_flags": ["nodejs_compat"]
 * }
 *
 *   wrangler secret put MONGODB_URI
 *   wrangler deploy
 *   curl https://atlas-spike.<you>.workers.dev
 */

import { MongoClient } from 'mongodb';

export interface Env {
  MONGODB_URI: string;
}

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    const marks: Record<string, number> = {};

    // CRITICAL: must be a non-SRV connection string.
    // mongodb+srv:// needs a DNS TXT/SRV lookup and workerd has no
    // dns.resolveTxt. Atlas gives you the legacy form under
    // Connect > Drivers > "Node.js 2.2.12 or later":
    //
    //   mongodb://h1:27017,h2:27017,h3:27017/?ssl=true
    //     &replicaSet=atlas-xxxxxx-shard-0&authSource=admin&retryWrites=true
    //
    if (env.MONGODB_URI?.startsWith('mongodb+srv://')) {
      return json({
        ok: false,
        fatal: 'SRV connection string. workerd cannot resolve it. Use the legacy multi-host form.',
      });
    }

    try {
      const t0 = Date.now();
      const client = new MongoClient(env.MONGODB_URI, {
        serverSelectionTimeoutMS: 5_000,
        connectTimeoutMS: 5_000,
        // One connection per isolate. There is no pool to reuse across
        // invocations, so a larger pool only buys extra handshakes.
        maxPoolSize: 1,
      });

      await client.connect();
      marks.connect_ms = Date.now() - t0;

      const t1 = Date.now();
      const db = client.db('social');
      await db.command({ ping: 1 });
      marks.ping_ms = Date.now() - t1;

      const t2 = Date.now();
      await db.collection('_spike').insertOne({ at: new Date() });
      const read = await db.collection('_spike').findOne({}, { sort: { at: -1 } });
      marks.roundtrip_ms = Date.now() - t2;

      await client.close();

      return json({ ok: true, marks, read_back: !!read, verdict: verdict(marks) });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      return json({ ok: false, marks, error: msg, hint: hintFor(msg) });
    }
  },
};

/**
 * Wall-clock is NOT CPU time — waiting on the network is free. But the TLS
 * handshake and SCRAM auth are real CPU. Read the true number from the Workers
 * dashboard under Metrics > CPU Time after ~10 runs. This is a smell test only.
 */
function verdict(m: Record<string, number>) {
  if (m.connect_ms > 3000) return 'SLOW — cold connect is painful. Use the hybrid fallback.';
  if (m.connect_ms > 1000) return 'WORKABLE — check CPU Time in the dashboard before committing.';
  return 'GOOD — now confirm CPU Time in the dashboard over ~10 runs.';
}

function hintFor(e: string) {
  if (/ENOTFOUND|EAI_AGAIN|resolveTxt|dns/i.test(e))
    return 'DNS. Almost certainly still an SRV string, or an unresolvable host.';
  if (/timed out|ETIMEDOUT|server selection/i.test(e))
    return 'Atlas Network Access is blocking you. Workers have no static egress IP — you need 0.0.0.0/0. Read the security note in docs/07 first.';
  if (/authentication|auth failed|SCRAM/i.test(e))
    return 'Credentials, or authSource is not admin.';
  if (/net\.|tls\.|Socket|not implemented/i.test(e))
    return 'Runtime gap. Bump compatibility_date, confirm nodejs_compat. If it persists the driver path is not viable — switch to the hybrid fallback in docs/02.';
  return 'Unclassified — paste the full error.';
}

function json(body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/* ----------------------------------------------------------------------
 * ALSO CHECK MANUALLY:
 *
 *   wrangler deploy --dry-run --outdir=dist && du -sh dist
 *
 * Free plan caps the Worker at 3MB. The mongodb driver plus BSON is not
 * small. If you are near the cap now, adding the rest of the pipeline pushes
 * you over — and that failure only appears at deploy time.
 * -------------------------------------------------------------------- */
