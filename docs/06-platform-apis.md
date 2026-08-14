# 06 — Platform APIs

Both platforms have deprecated the endpoints most tutorials still describe.
Treat anything you find elsewhere with suspicion unless it names `/rest/posts`
for LinkedIn and the container flow for Instagram.

## LinkedIn

### Access — you are starting from zero, so start here

| # | Step | Time | Risk |
|---|---|---|---|
| 1 | Create a **LinkedIn Company Page** | Same day | Low |
| 2 | Create a developer app associated with that Page | Minutes | Low |
| 3 | Verify the app — generates a link a Page admin clicks (you) | Minutes | Low |
| 4 | Request the **"Share on LinkedIn"** product → grants `w_member_social` | Usually immediate | Low |
| 5 | Test on your own account before writing code | — | — |

This is probably days, not weeks — **shorter than the Meta review**, so it is
not your critical path even from zero.

**Make the Page your practice, not a throwaway.** It is a hard API
prerequisite *and* the freelance storefront described in
[01](01-purpose-and-scope.md). One task, two purposes.

**The distinction that confuses everyone:** publishing to a **Company Page**
(`w_organization_social`) requires Marketing Developer Platform approval and is
genuinely partner-gated. Publishing to **your own profile**
(`w_member_social`) via "Share on LinkedIn" is not. Sources conflate these
constantly. This project only needs the second.

### Auth

- OAuth 2.0 authorization code flow
- Scopes: `w_member_social openid profile`
- **Access token: 60 days. No refresh token for non-MDP apps** — the OAuth
  response simply has no `refresh_token` field. By design, not misconfiguration.
- Refreshing therefore needs the full authorization flow, which needs a
  browser. It cannot be automated. It *can* be reduced to one tap.

**This constraint is the single reason the system runs on Cloudflare Workers
rather than GitHub Actions** — Actions has no public URL to receive the
redirect.

The nightly token-health cron nags at T-10 days with a link to
`/auth/linkedin`. Human time: ~30 seconds every two months.

### Publishing — three calls

```http
POST /rest/images?action=initializeUpload
  Authorization: Bearer <token>
  LinkedIn-Version: 2026MM
  X-Restli-Protocol-Version: 2.0.0
  { "initializeUploadRequest": { "owner": "urn:li:person:<sub>" } }
  → { "value": { "uploadUrl": "...", "image": "urn:li:image:..." } }

PUT <uploadUrl>
  Authorization: Bearer <token>
  <binary body — stream straight from R2, never buffer>

POST /rest/posts
  { author, commentary, visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [],
                    thirdPartyDistributionChannels: [] },
    content: { media: { id: "urn:li:image:..." } },
    lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false }
  → 201, post URN in the x-restli-id RESPONSE HEADER (not the body)
```

### Traps

| Trap | Detail |
|---|---|
| `LinkedIn-Version` is mandatory | Format `YYYYMM`. Omit it and `/rest/*` fails outright |
| Versions sunset on a rolling basis | Pinning and forgetting is not viable. Bump and re-test quarterly |
| `/v2/ugcPosts` + `/v2/assets` are the old generation | Still work but deprecated. This is what n8n's LinkedIn node uses |
| Post URN is in a header | `x-restli-id`, not the response body |
| No scheduling endpoint | Publishes immediately. Scheduling is your cron's job |
| No @mentions via API | Not supported |
| 3,000 character limit | Personal profiles |
| `sub` from `/v2/userinfo` | Builds `urn:li:person:<sub>`. Fetch once at OAuth time, store it |

---

## Instagram

### Access

1. Instagram **Professional** account (Business or Creator)
2. Meta developer app
3. **App review for `instagram_business_content_publish`** — **2–4 weeks**, no
   expedited path

**File this today.** It is the longest lead time in the project and nothing
else depends on it. Ship LinkedIn while it runs.

Two login flavours: Facebook Login (via a linked Page, better for many
accounts) and Instagram Login (direct, simpler for one). This project uses
Instagram Login.

### Auth — better than LinkedIn's

```http
GET https://graph.instagram.com/refresh_access_token
    ?grant_type=ig_refresh_token
    &access_token=<long-lived token>
```

- Long-lived token: 60 days
- Refreshable once **at least 24 hours old**
- Each refresh resets the clock to 60 days **from the refresh moment**
- Fully programmatic. **No human involvement, ever** — as long as it never lapses

Refresh nightly, unconditionally. There is no penalty for refreshing early, and
the failure mode of *not* refreshing is a full manual re-authorisation. Never
wait until day 55; a failure on day 59 leaves no room to retry.

### Publishing — three calls plus polling

```http
POST /v23.0/<IG_USER_ID>/media
  { "image_url": "https://<public>/img.jpg", "caption": "...", "access_token": "..." }
  → { "id": "<creation_id>" }

GET /<creation_id>?fields=status_code
  → IN_PROGRESS | FINISHED | ERROR | EXPIRED
  poll ~once a minute, max 5 minutes

POST /v23.0/<IG_USER_ID>/media_publish
  { "creation_id": "...", "access_token": "..." }
  → { "id": "<media id>" }
```

### The constraint that shapes the architecture

**Instagram will not accept file uploads.** Meta cURLs the URL you provide, so
media must be publicly hosted at the moment of the call. This is the entire
reason R2 with a public bucket is in the stack.

Consequences:

- The bucket cannot be auth-gated, behind Cloudflare Access, or use expiring
  pre-signed URLs
- **robots.txt on that domain must not block Meta's crawler.** It respects it,
  and the failure surfaces as the deeply unhelpful "Only photo or video can be
  accepted as media type"
- Serve **JPEG**, not PNG — more reliable and faster for Meta to fetch
- 8 MB maximum

### Traps

| Trap | Detail |
|---|---|
| No text-only posts | Every post needs media. This is why the IG persona is a carousel |
| Containers expire after 24h | Never split create and publish across cron runs |
| Publishing before `FINISHED` | Bare 400, no useful message |
| **Publish cap is genuinely ambiguous** | Meta's docs give both 100 and 50 on the same page; the widely-quoted 25 appears in neither. **Query `GET /<IG_ID>/content_publishing_limit`** instead of hardcoding |
| A carousel counts as one post | However many images it holds |
| Rolling window, not calendar | Not "resets at midnight" |
| Development mode | Only touches accounts added as Testers/Admins until review passes |
| `VIDEO` media type deprecated | Use `REELS` |
| Read the usage headers | `X-App-Usage`, `X-Business-Use-Case-Usage` on every response |

---

## Side by side

| | LinkedIn | Instagram |
|---|---|---|
| Approval lead time | Days (from zero) | **2–4 weeks** |
| Token life | 60 days | 60 days |
| Auto-refresh | ❌ Never for non-MDP | ✅ Fully automatic |
| Human touch needed | ~30s every 60 days | None |
| Media transfer | Upload bytes | **Public URL only** |
| Text-only posts | ✅ | ❌ |
| Scheduling endpoint | ❌ | ❌ |
| Versioning | `LinkedIn-Version` header, rolling sunset | Path-versioned (`/v23.0/`) |
| Publish cap | Not published | Query the endpoint |

**The counterintuitive result: Instagram is the easier platform to keep
running and the harder one to start. LinkedIn is the reverse.** Plan the
calendar accordingly — file the Meta review today, ship LinkedIn this week.
