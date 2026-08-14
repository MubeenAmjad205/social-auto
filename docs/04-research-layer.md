# 04 — Research Layer

## The problem, stated precisely

You want posts grounded in current developments. An LLM asked to write about
current developments with no retrieval will produce plausible, specific,
confidently-worded fiction — and it will attach source names to it, because you
asked for citations.

This is not hypothetical. The n8n workflow this project replaces instructed its
agent to include *"proper source attribution (e.g. 'according to [source]')"*
while giving it a search tool capped at one result inside a date window that
had already closed. That combination doesn't fail loudly. It produces polished
posts containing invented statistics, published under your name.

**The goal is not "add search." It is: make it structurally impossible for the
Writer to state a fact it wasn't handed.**

## Source tiers

### Tier 0 — free, keyless, unmetered

The backbone. No account, no quota, no way to run out. Query these first,
always. Critically: **their pricing cannot be changed out from under you**,
which is not true of any search API.

| Source | Endpoint | Good for | Notes |
|---|---|---|---|
| **arXiv** | `export.arxiv.org/api/query` | New papers in cs.LG, cs.CL, cs.CV, cs.AI | Atom XML. Self-limit to 1 req / 3s. Sort by `submittedDate` descending |
| **Hacker News** | `hn.algolia.com/api/v1/search_by_date` | What engineers are actually arguing about today | Free, no auth. `numericFilters=created_at_i>…,points>50` |
| **GitHub** | `api.github.com/search/repositories` | Fast-rising repos: `created:>YYYY-MM-DD sort:stars` | 60 req/hr anonymous, 5,000/hr with a PAT — use a PAT |
| **Hugging Face Hub** | `huggingface.co/api/models?sort=trendingScore` | Which models people are actually pulling | No key for public reads |
| **RSS** | see below | First-party announcements | Always better than an aggregator's summary of them |

**Feeds worth having:**

```
https://huggingface.co/blog/feed.xml
https://blog.cloudflare.com/rss/
https://openai.com/news/rss.xml
https://www.anthropic.com/news/rss.xml
https://blog.google/technology/ai/rss/
http://export.arxiv.org/rss/cs.LG
http://export.arxiv.org/rss/cs.CL
```

### Tier 1 — free, keyed, metered

| Source | Free tier | Cost/call | Use for |
|---|---|---|---|
| **Tavily** | 1,000 credits/month, no credit card | 1 basic, 2 advanced | Verifying a specific claim, or filling a gap Tier 0 missed |

At 1 post/day with ~1 search each, that's ~30 credits of 1,000 — **33× headroom**.
Spend it on `search_depth: "advanced"` when a claim actually matters, rather
than on doing more searches.

### Deliberately not used

| Option | Why not |
|---|---|
| Brave Search API | Perpetual free tier retired February 2026 in favour of a $5/month credit. No longer free |
| Google Custom Search JSON | Closed to new signups; discontinues 1 January 2027 |
| Bing Search API | Deprecated by Microsoft, 11 August 2025 |
| Serper / SerpAPI | One-time trial credits, not recurring. Also live litigation risk across the Google-scraping category |
| Reddit API | OAuth required, restrictive terms, poor signal-to-noise for this topic |

Two of the three historical free defaults for web search are gone. That is
precisely why Tier 0 carries the weight here.

## The grounding contract

Four mechanisms, strongest first.

### 1. Structural separation

The Researcher retrieves and returns `facts[]`. The Writer receives `facts[]`
and has **no network access and no tools**. It cannot search, so it cannot
invent a search result.

This is the strongest guarantee available, and it costs nothing.

### 2. The fact envelope

```ts
interface Fact {
  claim: string;        // verbatim from source — the Researcher does not rewrite
  source_name: string;  // "arXiv", "Hugging Face blog", "the FLUX.2 model card"
  url: string;          // stored for the record; NOT placed in the post body
  published_at: string; // ISO — the Writer must not call a 2024 result "new"
  snippet: string;      // surrounding context, so the claim isn't read out of context
}
```

`url` is deliberately withheld from the post body (link penalty, see
[03](03-agents-and-personas.md)) but persisted to Atlas, so six months later
you can answer "where did that number come from" in the comments.

### 3. Post-hoc validation

The Editor extracts every number, proper noun and model name from the draft and
checks each appears in `facts[]` or the seed. Unmatched items are flagged in
the Telegram message. Heuristic, not proof — see [03](03-agents-and-personas.md).

### 4. The empty-result rule — the most important rule here

**If `facts[]` is empty, the Writer is told so explicitly and writes a
seed-only post about your own work.**

The tempting alternative — "write something anyway" — is exactly how a grounded
pipeline degrades into a fabrication pipeline. A post about a bug you fixed
needs no citation and is more interesting than a rehash of a press release.

## Ranking candidates

Fan-out returns 20–40 items. The Researcher scores each:

| Signal | Weight | Reasoning |
|---|---|---|
| Recency | ×3 | Under 7 days is the point. A 6-month-old paper isn't news |
| Relevance to the seed | ×3 | The seed is the anchor. Unrelated novelty is noise |
| Primary source | ×2 | Model card > company blog > news write-up > aggregator |
| Corroboration | ×2 | Appearing in two independent sources |
| Specificity | ×1 | Contains a number, benchmark, or version |

Top 3–5 survive. Beyond five, the Writer produces a link-dump instead of an
argument.

## Deduplication

`sources_seen` in Atlas keys on a hash of the URL. A paper that seeded a post
last week doesn't seed another this week. Without this, a single high-profile
release will dominate your feed for days.

## The seed queue is not optional

Retrieval answers *"what's new."* Only you can answer *"why do I care."*

Add seeds by texting the bot:

```
/seed spent two days on a CUDA OOM that turned out to be the eval loop
      holding references to every batch
/seed FLUX.2 klein takes multipart form data even for a text-only prompt —
      cost me an hour
/seed client wanted RAG over 400 PDFs; chunking strategy mattered more than
      the model did
```

Thirty seconds each, whenever it happens. Note the third — client-shaped seeds
are what feed the freelance-flavoured posts.

**An empty seed queue is the real failure mode of this system** — not a broken
API, not an expired token. When it's empty the pipeline has nothing to anchor
on, and the only thing it can produce is exactly the generic commentary this
whole design exists to prevent.

Keep 5–10 banked. Refill weekly.

## Cost of one research run

```
arXiv           1 request      free
HN Algolia      2 requests     free
GitHub          1 request      free (PAT)
HF Hub          1 request      free
RSS             3 requests     free
Tavily          1 search       1 credit of 1,000/month
──────────────────────────────────────────────────────
                9 subrequests  (free plan allows 50 per invocation)
                ~30 credits/month of 1,000
```

Comfortably inside every limit. The tightest is subrequests, with 5× headroom —
and note that Atlas operations now also count against Cloudflare-service
subrequests, so keep an eye on it if you add sources.
