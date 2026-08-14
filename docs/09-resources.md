# 09 — Resources

Every link, quota, endpoint and reference in one place. **Free tiers move.**
Every figure here should be re-verified before you depend on it.

## Free-tier ledger

| Service | What you get free | Card needed? | Renews |
|---|---|---|---|
| **Cloudflare Workers** | 100k requests/day, 10 ms CPU/invocation, 50 external subrequests/invocation, 5 cron triggers, 3 MB worker size | No | Daily |
| **Workers AI** | 10,000 neurons/day, shared across all models | No | Daily, 00:00 UTC |
| **Cloudflare R2** | 10 GB-month storage, 1M Class A ops, 10M Class B ops | Yes (billing profile) | Monthly |
| **Cloudflare D1** | 5 GB, 5M rows read/day, 100k rows written/day | No | Daily |
| **MongoDB Atlas M0** | 512 MB shared cluster | No | — |
| **Tavily** | 1,000 API credits/month | **No** | Monthly |
| **Telegram Bot API** | Unmetered | No | — |
| **arXiv / HN Algolia / HF Hub** | Unmetered, no key | No | — |
| **GitHub API** | 60 req/hr anonymous, 5,000/hr with a PAT | No | Hourly |

**Total monthly cost: $0.**

## Workers AI image models — measured cost

Per 1024×1024 image, from Cloudflare's published per-model rates, against the
10,000 neuron/day free allocation:

| Model | Neurons | Images/day free | Verdict |
|---|---|---|---|
| `@cf/black-forest-labs/flux-1-schnell` | ~58 | ~170 | Cheapest. Older generation, weakest prompt adherence |
| **`@cf/black-forest-labs/flux-2-klein-4b`** | **~104** | **~96** | **Chosen.** FLUX.2, fixed 4 steps, multi-reference |
| `@cf/black-forest-labs/flux-2-klein-9b` | ~1,364 | ~7 | Best quality that still fits a daily cadence |
| `@cf/black-forest-labs/flux-2-dev` (25 steps) | ~3,750 | ~2 | Too expensive to iterate on |
| `@cf/leonardo/lucid-origin` | ~2,900 | ~3 | Same problem |

**Text generation is negligible by comparison.** `@cf/openai/gpt-oss-20b` at
27,273 neurons per million output tokens means a 500-token post costs about
**14 neurons**. Images are ~99% of your spend, so pick the text model on
quality, not price.

### Two API shapes, and this will break you if you swap models blind

```ts
// FLUX.1 — plain JSON, returns { image: "<base64>" }
const res = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
  prompt, seed, steps: 4
});

// FLUX.2 — MULTIPART FORM DATA, even for a text-only prompt.
// steps is fixed at 4 (distilled) and cannot be changed.
const form = new FormData();
form.append('prompt', prompt);
form.append('width', '1024');
form.append('height', '1024');
// FormData won't expose its boundary — wrap it in a Response to serialize it.
const serialized = new Response(form);
const res = await env.AI.run('@cf/black-forest-labs/flux-2-klein-4b', {
  multipart: { body: serialized.body,
               contentType: serialized.headers.get('content-type') }
});
```

**Both return a base64 string, not a stream.** The decode is unavoidable and is
the main CPU cost in the pipeline.

### Multi-reference — the feature almost nobody uses

FLUX.2 klein accepts up to **4 reference images**, each under 512×512, named
`input_image_0` … `input_image_3`. Store 2–3 approved graphics in `style_refs`
and every future image inherits the same visual language.

This is a free, consistent brand system. It matters more than model quality —
consistency is what makes a feed read as deliberate.

## Research endpoints

```
arXiv        http://export.arxiv.org/api/query
             ?search_query=cat:cs.LG+AND+abs:%22<term>%22
             &sortBy=submittedDate&sortOrder=descending&max_results=10
             → Atom XML. Self-limit to 1 request / 3 seconds.

HN Algolia   https://hn.algolia.com/api/v1/search_by_date
             ?query=<term>&tags=story
             &numericFilters=created_at_i>{unix},points>50
             → JSON. Free, no auth.

GitHub       https://api.github.com/search/repositories
             ?q=<term>+created:>2026-08-01&sort=stars&order=desc
             Header: Authorization: Bearer <PAT>

HF Hub       https://huggingface.co/api/models?sort=trendingScore&limit=20
             https://huggingface.co/api/datasets?sort=trendingScore&limit=10
             → JSON. No key for public reads.

Tavily       POST https://api.tavily.com/search
             { query, search_depth: "advanced", max_results: 5,
               topic: "news", days: 7, include_answer: false }
             Header: Authorization: Bearer <key>
```

**RSS feeds**

```
https://huggingface.co/blog/feed.xml
https://blog.cloudflare.com/rss/
https://openai.com/news/rss.xml
https://www.anthropic.com/news/rss.xml
https://blog.google/technology/ai/rss/
http://export.arxiv.org/rss/cs.LG
http://export.arxiv.org/rss/cs.CL
```

## Platform endpoints

### LinkedIn

```
Authorize    https://www.linkedin.com/oauth/v2/authorization
Token        https://www.linkedin.com/oauth/v2/accessToken
Userinfo     https://api.linkedin.com/v2/userinfo          → { sub }
Image init   https://api.linkedin.com/rest/images?action=initializeUpload
Post         https://api.linkedin.com/rest/posts

Required headers on /rest/*:
  LinkedIn-Version: YYYYMM          ← mandatory, rolling sunset
  X-Restli-Protocol-Version: 2.0.0
Scope: w_member_social openid profile
Post URN returns in the `x-restli-id` RESPONSE HEADER.
```

### Instagram

```
Refresh      GET  https://graph.instagram.com/refresh_access_token
                  ?grant_type=ig_refresh_token&access_token=<token>
Container    POST https://graph.instagram.com/v23.0/<IG_ID>/media
Status       GET  https://graph.instagram.com/<creation_id>?fields=status_code
Publish      POST https://graph.instagram.com/v23.0/<IG_ID>/media_publish
Quota        GET  https://graph.instagram.com/<IG_ID>/content_publishing_limit

Permission: instagram_business_content_publish (2–4 week app review)
```

### Telegram

```
https://api.telegram.org/bot<TOKEN>/sendMessage
https://api.telegram.org/bot<TOKEN>/sendPhoto
https://api.telegram.org/bot<TOKEN>/answerCallbackQuery
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<your worker>/tg/<secret>

Bot creation: @BotFather      Your chat id: @userinfobot
```

## Deprecated — do not use, and distrust any tutorial that does

| Thing | Status |
|---|---|
| **MongoDB Atlas Data API / App Services / HTTPS Endpoints** | **EOL 30 September 2025.** This is why the Node driver is used directly |
| LinkedIn `/v2/ugcPosts`, `/v2/assets?action=registerUpload` | Deprecated. n8n's LinkedIn node still uses these |
| Instagram Basic Display API | Deprecated; replaced by Instagram Login |
| Instagram `VIDEO` media type | Use `REELS` |
| Bing Search API | Deprecated 11 August 2025 |
| Google Custom Search JSON | Closed to new signups; sunsets 1 January 2027 |
| Brave Search API free tier | Retired February 2026 |

## Documentation worth bookmarking

```
Workers limits       developers.cloudflare.com/workers/platform/limits
Workers AI pricing   developers.cloudflare.com/workers-ai/platform/pricing
Workers AI models    developers.cloudflare.com/workers-ai/models
R2                   developers.cloudflare.com/r2
Cron Triggers        developers.cloudflare.com/workers/configuration/cron-triggers

LinkedIn Posts API   learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api
LinkedIn OAuth       learn.microsoft.com/linkedin/shared/authentication/authorization-code-flow
Instagram publish    developers.facebook.com/docs/instagram-platform/content-publishing
Instagram token      developers.facebook.com/docs/instagram-platform/reference/refresh_access_token

Telegram Bot API     core.telegram.org/bots/api
Tavily               docs.tavily.com
Atlas driver         mongodb.com/docs/drivers/node
```

## Numbers to re-verify before depending on them

| Claim | Source quality | Why re-check |
|---|---|---|
| Neuron costs per model | Cloudflare's own pricing page — **solid** | Cloudflare re-prices models |
| Workers free-plan limits | Cloudflare docs — **solid** | Changed in Feb 2026 (subrequests) |
| LinkedIn link reach penalty (~19–60%) | Creator analyses, **not LinkedIn** | Wide spread; directionally consistent only |
| "LinkedIn detects generic AI at 94%" | LinkedIn's own claim via marketing blogs — **weak** | Vendor-reported, unaudited |
| Instagram publish cap (25 / 50 / 100) | **Meta's docs contradict themselves** | Query `content_publishing_limit` instead |
| Tavily 1,000 credits/month | Vendor pricing page | Tavily was acquired by Nebius in Feb 2026 — pricing may shift |

The pattern: **trust first-party technical documentation, treat marketing-blog
statistics as directional, and query an endpoint over hardcoding a number
whenever one exists.**
