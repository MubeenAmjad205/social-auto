# 03 — Agents & Personas

## The four agents

Each has one job and a hard boundary. The boundaries are the design.

### 1. Researcher — retrieves, never writes

**In:** the seed + today's date
**Out:** `facts[]` — `{ claim, source_name, url, published_at, snippet }[]`
**Tools:** arXiv, HN Algolia, GitHub, Hugging Face Hub, RSS, Tavily
**Hard rule:** may not paraphrase, summarise or synthesise. Returns retrieved
text verbatim with attribution. **Returning nothing is a valid result.**

### 2. Writer — writes, cannot retrieve

**In:** the seed + `facts[]`, and nothing else
**Out:** post text only
**Hard rule:** every factual claim must trace to `facts[]`. Claims about your
own experience need no source — that's what the seed is for. If `facts[]` is
empty, write a seed-only post.

Having no search tool is not a limitation, it is the entire mechanism. It
cannot fabricate a citation because it has never seen the internet.

### 3. Art Director — post → image prompt

**In:** the finished post
**Out:** one paragraph, under 60 words
**Hard rule:** the image must contain **no words, letters, numbers or UI text**.

Even FLUX.2 mangles a headline occasionally, and a typo'd graphic reads as
"didn't look before posting" — the exact impression this account exists to
avoid. The words live in the post body where they render perfectly and are
searchable.

### 4. Editor — mechanical validator, not an LLM

Checks before the draft reaches Telegram:

- Length within limits (LinkedIn hard cap 3,000 chars; target 120–200 words)
- No URL in the body
- Every number and proper noun appears in `facts[]` or the seed
- No phrase from the banned list
- Hashtags ≤ 3

Failures **annotate, they don't block**:

```
⚠️ unverified: "40% faster", "Llama 4.2"
⚠️ banned phrase: "leverage"
```

A validator that silently rewrites is worse than one that flags. This is a
heuristic and it will produce false positives on ordinary prose. That's the
right trade — dismissing a flag costs two seconds, a fabricated statistic costs
your credibility.

---

## The LinkedIn persona

### Identity

*An engineer who shows their work.* Three years into Gen AI / ML. Mid-career,
not a guru. Writes the way you'd explain something to a competent colleague who
wasn't in the room.

The positioning gap: LinkedIn is saturated with people explaining AI at a level
any newsletter already covers. It is short on people saying "here is the
specific thing that broke and what I learned." The second is much harder to
fake, and it is the only kind of post that serves both a hiring manager and a
prospective client at once.

### Serving both audiences without splitting the voice

**Do not write two personas.** Rotate the *subject*, keep the voice identical.

| Mix | Post subject | Reads as |
|---|---|---|
| ~2/3 | Your own infrastructure, debugging, trade-offs, benchmarks | "Good engineer" → **roles** |
| ~1/3 | A problem shaped like a client's, and the outcome | "Hireable for work" → **freelance** |

The freelance-flavoured post is *not* an advertisement. It's the same
debugging-story shape with a different subject:

> ✅ "A small e-commerce team needed product descriptions generated from spec
> sheets. The obvious approach — one prompt per product — cost more than the
> descriptions were worth. Here's what actually worked and what it cost."

> ❌ "DM me for AI automation services! I help businesses 10x their content 🚀"

The first demonstrates delivery. The second is why people mute LinkedIn.

**Availability never goes in a post.** It goes in your profile headline (one
field, changeable in ten seconds) and on the Company Page. Layer separation —
see [01](01-purpose-and-scope.md).

### Voice rules

**Do**
- First person, past tense, about something that actually happened
- Name the tool, version, number, error message
- One idea per post — resist the listicle reflex
- Admit what didn't work. A post about a dead end is more trustworthy than a
  post about a win
- Attribute by name, not by link: "per the FLUX.2 model card," not a URL
- End with a question only if you'd genuinely want the answer

**Don't**
- Hook formulas: "Here's what nobody tells you about…", "Unpopular opinion:"
- One-sentence-per-line ladder formatting
- Engagement bait: "Agree? 👇", "Comment YES if…"
- Vague authority: "studies show", "experts agree", "research suggests"
- Emoji bullets, or more than one emoji total
- Present-tense generalities about "the future of AI"

### Banned phrases — checked mechanically by the Editor

```
delve                 in today's fast-paced        it's not just X, it's Y
tapestry              game-changer                 unlock the power
navigate the          revolutionize                at the end of the day
leverage (verb)       seamlessly                   in the ever-evolving landscape
testament to          paradigm shift               let that sink in
supercharge           dive deep                    the future is here
```

These are the specific tokens that make a reader think "an LLM wrote this,"
which is a worse outcome than a slightly clumsy human sentence.

### On links

External links in the post body cost meaningful reach on LinkedIn in 2026.
Reported figures range from ~19% to ~60% depending on whose analysis you read,
and the old first-comment workaround has largely been patched. Treat the exact
numbers as directional — they come from creator analyses, not LinkedIn — but
the direction is consistent enough to design around.

**Decision: name sources in prose, never link them.** Anyone who wants the
paper can search the title. This also forces the post to stand on its own,
which is what the algorithm rewards anyway.

### Post shapes that work

| Shape | Structure | Use when | Serves |
|---|---|---|---|
| Debugging story | symptom → wrong hypothesis → actual cause → generalisable lesson | You fixed something non-obvious | Roles |
| Benchmark | what you measured, how, the number, what surprised you | You have real data | Roles |
| Trade-off | two viable options, what each costs, which you picked, why | An architecture decision | Both |
| Client outcome | constraint → naive approach → what it cost → what worked | You shipped something for someone | Freelance |
| Correction | what you believed, why it was wrong, what changed your mind | Rare | Both — disproportionately effective |
| Primer | one concept, precisely, no metaphor stretched past use | A paper genuinely landed | Roles |

### A note on this project as content

The pipeline you're building is itself strong material for both audiences:
free-tier constraint engineering, a multi-agent design with an enforced
grounding contract, two OAuth systems with opposite refresh semantics. That's
several posts of the "trade-off" and "debugging story" shapes.

Write them by hand before the pipeline exists. It's the most honest possible
first post.

---

## The Instagram persona — specified, deferred to v1.1

Instagram is **not** LinkedIn with a different image size.

### Constraints that force the difference

- The API refuses text-only posts. Every post needs media
- Static single images get minimal reach in 2026; carousels and Reels don't
- Meta fetches media from a **public URL**; it will not accept bytes
- The caption is secondary — the image carries the message

### Identity

The same engineer, teaching visually. Slightly more casual. Less "here's what I
concluded," more "here's how this works."

### Unit of content — a 6–8 slide carousel

```
1  The question or symptom        (must work as a standalone thumbnail)
2  Why the obvious answer fails
3  ─┐
4   ├ the actual explanation, one idea per slide
5  ─┘
6  A concrete example with real numbers
7  The takeaway in one sentence
8  Soft CTA — "save this" beats "follow me"
```

### Why deferred

Carousel slides need **legible text rendered onto the image**. That's a
compositing problem, not a generation problem — it needs a deterministic
rasteriser, and both viable options are CPU-heavy against a 10 ms budget.
Asking FLUX to render slide text fails roughly one time in five, which is
unusable for a teaching format. Options in [08](08-roadmap.md).

## Cross-posting: don't

The same content in both places performs worse in both. LinkedIn wants the
argument in text; Instagram wants it in the image. A LinkedIn post pasted under
an abstract graphic reads as spam on Instagram; a carousel's slide text reads
as thin on LinkedIn.

**The shared asset is the seed, not the post.** One thing you learned becomes a
LinkedIn debugging story and an Instagram carousel — written separately, from
the same source of truth.
