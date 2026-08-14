/**
 * src/errors.ts
 *
 * `idempotency_key` (see docs/05, src/store.ts) has a unique index in Atlas,
 * but it is never actually sent to LinkedIn or Instagram — neither API
 * accepts a client idempotency token in this implementation. So the index
 * only prevents US from inserting two draft documents with a colliding key
 * (already near-impossible with crypto.randomUUID()). It does NOT protect
 * against the failure mode docs/07 actually describes: a publish call that
 * times out on our end after the platform already processed it, retried
 * into a genuine duplicate post.
 *
 * The real fix would be platform support for client-supplied idempotency —
 * not available here. The achievable mitigation: distinguish "the platform
 * responded and said no" (safe to retry — nothing was created) from "the
 * network call itself failed before any response" (unsafe to retry — we
 * genuinely don't know). Callers that hit the second case should stop
 * auto-retrying and ask a human to check the platform first.
 */
export class AmbiguousPublishError extends Error {}

export async function fetchOrAmbiguous(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err: any) {
    throw new AmbiguousPublishError(`network error before any response: ${err?.message ?? err}`);
  }
}
