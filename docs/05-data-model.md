# 05 — Data Model

**One datastore: MongoDB Atlas M0.** Rationale and constraints in
[02](02-architecture.md). R2 holds image bytes only.

Database: `social`

## Collections

### `drafts`

The state machine. One document per generated post.

```js
{
  _id: "<uuid>",
  platform: "linkedin",              // "linkedin" | "instagram"
  status: "pending",                 // pending|approved|rejected|published|failed
  body: "…post copy…",
  image_key: "img/2026-08-13/uuid.jpg",   // R2 key; null triggers a redraw
  image_prompt: "…",                      // kept so you can debug a bad image
  seed: { _id: 42, note: "…", angle: "…" },   // embedded — no join needed
  facts: [                                     // full provenance, embedded
    { claim, source_name, url, published_at, snippet }
  ],
  editor_flags: ["unverified: 40% faster"],
  attempts: 0,                       // incremented BEFORE the network call
  last_error: null,
  remote_id: null,                   // urn:li:share:… or IG media id
  idempotency_key: "li-<uuid>",      // unique index — guards double-publish
  created_at: ISODate(),
  published_at: null
}
```

Embedding `seed` and `facts` rather than referencing them is the one place the
document model genuinely earns its keep here: a draft is always read whole, and
you never want to discover the source list was garbage-collected.

**Status transitions**

```
        generate           tap ✅            cron publish
  ──────────────► pending ─────────► approved ──────────► published
                     │                   │
              tap 🗑 │            3 failures
                     ▼                   ▼
                 rejected              failed

  tap 🎲 → image_key = null, status stays pending, regenerated next run
```

### `tokens`

One document per platform. **The most security-sensitive data in the system** —
these are live posting credentials for your identity, sitting in a database
that (see [02](02-architecture.md)) must accept connections from `0.0.0.0/0`.

```js
{
  _id: "linkedin",                   // "linkedin" | "instagram"
  ciphertext: BinData(...),          // AES-GCM encrypted access token
  iv: BinData(...),                  // 12-byte nonce, unique per write
  expires_at: ISODate(),
  member_urn: "urn:li:person:xxxx",  // LinkedIn only, from /v2/userinfo
  updated_at: ISODate()              // IG refresh requires token >24h old
}
```

**The plaintext token is never written to Atlas.** The key lives only in
`wrangler secret` as `TOKEN_KEY`. See `src/secrets.ts`. A dump of this
collection yields ciphertext, not your LinkedIn account.

This mitigation is what makes the all-Atlas decision defensible. Implement it
**before** storing the first token — retrofitting means re-authing everything.

### `seeds`

Your own material. The anchor for every post.

```js
{
  _id: ObjectId(),
  note: "spent two days on a CUDA OOM…",   // what happened, in your words
  angle: "eval loops hold references",     // optional, if you know the takeaway
  kind: "own",                             // "own" | "client" — drives the 2:1 mix
  used_at: null,                           // null = unused; FIFO
  created_at: ISODate()
}
```

`kind` is what lets the generator hold roughly a 2:1 ratio of
infrastructure-depth posts to client-outcome posts — the mix described in
[03](03-agents-and-personas.md).

### `style_refs`

R2 keys of approved images, each under 512×512, fed to FLUX.2 as
multi-reference inputs. This is what makes the feed look like one designer made
it rather than a random image model.

```js
{ _id: ObjectId(), image_key: "refs/a.jpg", active: true }
```

Max 3 active. The model accepts up to 4 inputs and rejects references over
512×512.

### `runs`

One document per cron execution. Your debugging history.

```js
{
  _id: ObjectId(),
  cron: "0 2 * * *",
  started_at: ISODate(),
  duration_ms: 5860,
  ok: true,
  steps: [
    { name: "research", ms: 1840, sources_hit: 6, facts_found: 4 },
    { name: "write",    ms: 920,  neurons_est: 14 },
    { name: "image",    ms: 3100, neurons_est: 104, model: "flux-2-klein-4b" }
  ],
  neurons_total_est: 118,
  error: null
}
```

TTL index at 180 days — debugging history goes stale.

### `posts`

Permanent record of everything published. Never expires. This is the archive.

```js
{
  _id: ObjectId(),
  draft_id: "<uuid>",
  platform: "linkedin",
  remote_id: "urn:li:share:…",
  published_at: ISODate(),
  body, image_key, image_prompt,
  seed: { note, angle, kind },
  facts: [ … ],                  // full provenance, kept forever
  editor_flags: [ … ],
  metrics: { }                   // filled by v1.2
}
```

`metrics` is where the document model pays for itself later: LinkedIn returns
impressions, unique impressions and clicks; Instagram returns reach, saves,
profile visits and sticker taps. Modelling that relationally means a wide
sparse table or a join per metric.

### `sources_seen`

Cross-run deduplication.

```js
{ _id: "<sha256 of url>", url, title, source_name, first_seen, times_used }
```

## Indexes

Run once at setup — see `src/migrate.ts`.

```js
db.drafts.createIndex({ platform: 1, status: 1, created_at: 1 })       // dueFor()
db.drafts.createIndex({ idempotency_key: 1 }, { unique: true })        // double-publish guard
db.seeds.createIndex({ used_at: 1, kind: 1, created_at: 1 })           // nextSeed()
db.style_refs.createIndex({ active: 1 })
db.posts.createIndex({ published_at: -1 })
db.runs.createIndex({ started_at: 1 }, { expireAfterSeconds: 15552000 })  // 180d TTL
db.sources_seen.createIndex({ first_seen: 1 })
```

The unique index on `idempotency_key` is load-bearing. It is the last line of
defence against a timed-out-but-successful publish being retried into a
duplicate post.

## The `Store` interface

Everything goes through one interface. Two reasons this matters:

1. If `spike/atlas-check.ts` shows the Atlas hot path is too slow or too CPU-
   expensive, the fallback (D1 for tokens + drafts, Atlas for runs + posts) is
   a one-file change rather than a rewrite.
2. It keeps token encryption in exactly one place, so it cannot be forgotten.

```ts
export type Platform = 'linkedin' | 'instagram';
export type Status = 'pending' | 'approved' | 'rejected' | 'published' | 'failed';

export interface Store {
  // tokens — encryption/decryption happens INSIDE these two methods only
  getToken(p: Platform): Promise<DecryptedToken | null>;
  saveToken(p: Platform, t: PlainToken): Promise<void>;

  // drafts
  createDraft(d: NewDraft): Promise<string>;
  setStatus(id: string, s: Status, patch?: Partial<Draft>): Promise<void>;
  dueFor(p: Platform, limit: number): Promise<Draft[]>;
  clearImage(id: string): Promise<void>;

  // seeds
  nextSeed(preferKind?: 'own' | 'client'): Promise<Seed | null>;
  addSeed(note: string, kind: 'own' | 'client', angle?: string): Promise<void>;
  markSeedUsed(id: string): Promise<void>;
  seedCount(): Promise<number>;

  // style
  activeStyleRefs(): Promise<string[]>;

  // archive — always called via ctx.waitUntil(), never awaited on the hot path
  logRun(r: RunLog): Promise<void>;
  recordPost(p: PostRecord): Promise<void>;
  seenSource(url: string): Promise<boolean>;
  markSourceSeen(s: SourceRecord): Promise<void>;
}
```

`MongoStore implements Store` is the only implementation in v1. If the spike
fails, add `HybridStore` — D1 for the first three groups, Atlas for the last.

## Retention

| Data | Kept | Why |
|---|---|---|
| `drafts` published/rejected | 90 days | Permanent copy lives in `posts` |
| `tokens` | Until replaced | |
| `seeds` (used) | Forever | Cheap, and revealing about what you actually write about |
| R2 images | Forever (~15 MB/month) | The 10 GB free allowance takes decades to fill |
| `runs` | 180 days (TTL) | Debugging history goes stale |
| `posts` | Forever | This is the archive |

M0 gives 512 MB. At this volume you will not approach it.
