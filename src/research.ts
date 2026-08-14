/**
 * src/research.ts — the Researcher agent.
 *
 * Retrieves. Never writes prose. Never paraphrases.
 *
 * The output of this file is the ONLY factual material the Writer will ever
 * see, because the Writer has no tools and no network access. That wall is
 * what makes the grounding contract enforceable rather than aspirational.
 *
 * If this returns an empty array, that is a valid result. The Writer is told
 * so and falls back to a seed-only post. See docs/04.
 */

import type { Env } from './index';
import type { Fact, Seed, Store } from './store';

const UA = 'social-worker/1.0 (personal publishing pipeline)';

export async function research(env: Env, store: Store, seed: Seed): Promise<Fact[]> {
  const terms = keyTerms(seed.note);
  const since = new Date(Date.now() - 7 * 864e5);

  // Fan out across free sources. Every one of these is allowed to fail
  // without taking down the run — a missing source is a smaller problem
  // than no post at all.
  const batches = await Promise.allSettled([
    arxiv(terms),
    hackerNews(terms, since),
    github(env, terms, since),
    huggingFace(),
    tavily(env, terms),
  ]);

  const candidates = batches
    .filter((b): b is PromiseFulfilledResult<Candidate[]> => b.status === 'fulfilled')
    .flatMap(b => b.value);

  // Drop anything that already seeded a post. Without this, one high-profile
  // release dominates the feed for a week.
  const fresh: Candidate[] = [];
  for (const c of candidates) {
    if (!(await store.seenSource(c.url))) fresh.push(c);
  }

  const ranked = fresh
    .map(c => ({ c, score: score(c, terms) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(x => x.c);

  for (const c of ranked) {
    await store.markSourceSeen({ url: c.url, title: c.title, source_name: c.source_name });
  }

  // Verbatim only. The Researcher does not rewrite; rewriting is where
  // invention creeps in.
  return ranked.map(c => ({
    claim: c.title,
    source_name: c.source_name,
    url: c.url,
    published_at: c.published_at,
    snippet: c.snippet.slice(0, 600),
  }));
}

// ---------------------------------------------------------------- sources

interface Candidate {
  title: string;
  url: string;
  source_name: string;
  published_at: string;
  snippet: string;
  primary: boolean;   // model card / official blog / paper, vs commentary
  specific: boolean;  // contains a number, version, or benchmark
}

/** arXiv. Free, no key. Self-limit to 1 request / 3s. */
async function arxiv(terms: string[]): Promise<Candidate[]> {
  const q = `cat:cs.LG+OR+cat:cs.CL+AND+all:${encodeURIComponent(terms[0] ?? 'machine learning')}`;
  const url = `http://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=5`;
  const xml = await fetch(url, { headers: { 'User-Agent': UA } }).then(r => r.text());

  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => {
    const e = m[1];
    const title = tag(e, 'title').replace(/\s+/g, ' ').trim();
    const summary = tag(e, 'summary').replace(/\s+/g, ' ').trim();
    return {
      title,
      url: tag(e, 'id'),
      source_name: 'arXiv',
      published_at: tag(e, 'published'),
      snippet: summary,
      primary: true,
      specific: hasNumbers(summary),
    };
  });
}

/** Hacker News via Algolia. Free, no auth. Signals what engineers care about. */
async function hackerNews(terms: string[], since: Date): Promise<Candidate[]> {
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(terms.join(' '))}`
    + `&tags=story&numericFilters=created_at_i>${Math.floor(+since / 1000)},points>50`;
  const json: any = await fetch(url).then(r => r.json());

  return (json.hits ?? []).slice(0, 5).map((h: any) => ({
    title: h.title,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    source_name: 'Hacker News',
    published_at: h.created_at,
    snippet: `${h.points} points, ${h.num_comments} comments`,
    primary: false,
    specific: hasNumbers(h.title ?? ''),
  }));
}

/** GitHub. 60/hr anonymous, 5,000/hr with a PAT — always use the PAT. */
async function github(env: Env, terms: string[], since: Date): Promise<Candidate[]> {
  const d = since.toISOString().slice(0, 10);
  const url = `https://api.github.com/search/repositories`
    + `?q=${encodeURIComponent(terms.join(' '))}+created:>${d}&sort=stars&order=desc&per_page=5`;
  const json: any = await fetch(url, {
    headers: { 'User-Agent': UA, Authorization: `Bearer ${env.GITHUB_PAT}` },
  }).then(r => r.json());

  return (json.items ?? []).map((r: any) => ({
    title: `${r.full_name}: ${r.description ?? ''}`.trim(),
    url: r.html_url,
    source_name: 'GitHub',
    published_at: r.created_at,
    snippet: `${r.stargazers_count} stars since ${d}`,
    primary: true,
    specific: true,
  }));
}

/** Hugging Face Hub. No key for public reads. What people are actually pulling. */
async function huggingFace(): Promise<Candidate[]> {
  const json: any = await fetch(
    'https://huggingface.co/api/models?sort=trendingScore&limit=5',
    { headers: { 'User-Agent': UA } }
  ).then(r => r.json());

  return (json ?? []).map((m: any) => ({
    title: `${m.id} trending on Hugging Face`,
    url: `https://huggingface.co/${m.id}`,
    source_name: 'Hugging Face',
    published_at: m.lastModified ?? new Date().toISOString(),
    snippet: `${m.downloads ?? 0} downloads, ${m.likes ?? 0} likes`,
    primary: true,
    specific: true,
  }));
}

/**
 * Tavily. 1,000 credits/month free, ~30 used. Spend the headroom on
 * search_depth "advanced" rather than on more searches.
 */
async function tavily(env: Env, terms: string[]): Promise<Candidate[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query: terms.join(' '),
      search_depth: 'advanced',
      topic: 'news',
      days: 7,              // never hardcode absolute dates — they go stale silently
      max_results: 5,
      include_answer: false, // we want sources, not Tavily's synthesis
    }),
  });
  if (!res.ok) return [];
  const json: any = await res.json();

  return (json.results ?? []).map((r: any) => ({
    title: r.title,
    url: r.url,
    source_name: hostOf(r.url),
    published_at: r.published_date ?? new Date().toISOString(),
    snippet: r.content ?? '',
    primary: false,
    specific: hasNumbers(r.content ?? ''),
  }));
}

// ---------------------------------------------------------------- ranking

function score(c: Candidate, terms: string[]): number {
  const ageDays = (Date.now() - Date.parse(c.published_at)) / 864e5;
  const recency = ageDays < 2 ? 3 : ageDays < 7 ? 2 : ageDays < 30 ? 1 : 0;

  const hay = `${c.title} ${c.snippet}`.toLowerCase();
  const relevance = terms.filter(t => hay.includes(t.toLowerCase())).length;

  return recency * 3
    + Math.min(relevance, 3) * 3
    + (c.primary ? 2 : 0)
    + (c.specific ? 1 : 0);
}

// ----------------------------------------------------------------- utils

function keyTerms(note: string): string[] {
  const stop = new Set(['the','a','an','and','or','but','for','with','that','this','was','were','have','been','from','into','out','turned','spent','two','days']);
  return note.toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stop.has(w))
    .slice(0, 5);
}

const tag = (xml: string, name: string) =>
  xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? '';

const hasNumbers = (s: string) => /\d/.test(s);

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'web'; } };
