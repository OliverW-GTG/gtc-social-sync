// ============================================================
// GTC Social Performance sync  (single file)
// Windsor.ai  ->  tag each post  ->  Supabase
//
// This is called by your scheduler at:
//   /api/sync?mode=recent&token=YOUR_SECRET
// Modes:
//   recent    -> last few days      (run every 3 hours)
//   reconcile -> the current month  (run once overnight)
//   backfill  -> the last 12 months (run once by hand to load history)
// ============================================================

import { createClient } from '@supabase/supabase-js';

const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// ============================================================
// CONFIG: the field names Windsor returns for each column.
// Instagram is set from Windsor's own reference. Facebook uses
// Windsor's current standard names. If a Facebook name is off,
// the first run will report it and only Facebook is affected.
// ============================================================
const CONFIG = {
  Instagram: {
    connector:    'instagram',
    accountId:    '17841404427634298',   // GTC Instagram
    accountField: 'account_id',
    fields: {
      id: 'media_id', date: 'date', permalink: 'permalink', caption: 'media_caption',
      reach: 'media_reach', impressions: 'media_impressions',
      likes: 'media_like_count', comments: 'media_comments_count',
      saves: 'media_saved', shares: 'media_shares'
    }
  },
  Facebook: {
    connector:    'facebook_organic',
    accountId:    '984913224898857',     // GTC Facebook page
    accountField: 'page_id',
    fields: {
      id: 'post_id', date: 'date', permalink: 'permalink_url', caption: 'message',
      reach: 'post_impressions_unique', impressions: 'post_impressions',
      likes: 'post_reactions_like_total', comments: 'post_comments',
      saves: 'post_saves', shares: 'post_shares'
    }
  }
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };
const iso = (d) => d.toISOString().slice(0, 10);

function monthChunks(from, to) {
  const chunks = [];
  let cur = new Date(from.getFullYear(), from.getMonth(), 1);
  while (cur <= to) {
    const start = new Date(cur);
    const end   = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    chunks.push({ from: start < from ? from : start, to: end > to ? to : end });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return chunks;
}

async function fetchWindsor(platform, { from, to, recent }) {
  const cfg = CONFIG[platform];
  const wanted = Object.values(cfg.fields).join(',');
  const params = new URLSearchParams({ api_key: WINDSOR_API_KEY, fields: wanted });

  if (cfg.accountId) {
    params.set('filter', JSON.stringify([[cfg.accountField, 'eq', cfg.accountId]]));
  }
  if (recent) {
    params.set('refresh_since', '3d');
    params.set('refresh_interval', '3h');
  } else {
    params.set('date_from', iso(from));
    params.set('date_to', iso(to));
  }

  const url = `https://connectors.windsor.ai/${cfg.connector}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${platform} Windsor error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const rows = json.data || json || [];

  return rows.map((r) => {
    const f = cfg.fields;
    const likes = num(r[f.likes]), comments = num(r[f.comments]);
    const saves = num(r[f.saves]), shares = num(r[f.shares]);
    return {
      id: String(r[f.id]), platform,
      posted_at: new Date(r[f.date]).toISOString(),
      permalink: r[f.permalink] || null,
      caption: r[f.caption] || '',
      reach: num(r[f.reach]), impressions: num(r[f.impressions]),
      likes, comments, saves, shares,
      engagement: likes + comments + saves + shares
    };
  }).filter((p) => p.id && p.id !== 'undefined');
}

async function buildResolver() {
  const [{ data: cr }, { data: rl }] = await Promise.all([
    supabase.from('country_region').select('country,region'),
    supabase.from('resort_lookup').select('name,country,aliases')
  ]);
  const regionByCountry = Object.fromEntries((cr || []).map((x) => [x.country, x.region]));
  const resorts = (rl || []).map((x) => ({
    name: x.name, country: x.country,
    region: regionByCountry[x.country] || null,
    aliases: (x.aliases && x.aliases.length ? x.aliases : [x.name.toLowerCase()])
  }));
  return (caption) => {
    const c = (caption || '').toLowerCase();
    for (const r of resorts) {
      for (const a of r.aliases) {
        if (a && c.includes(a)) return { resort: r.name, country: r.country, region: r.region };
      }
    }
    return { resort: null, country: null, region: null };
  };
}

async function runSync(mode = 'recent') {
  const resolve = await buildResolver();
  const now = new Date();

  let windows;
  if (mode === 'recent') {
    windows = [{ recent: true }];
  } else if (mode === 'reconcile') {
    windows = monthChunks(new Date(now.getFullYear(), now.getMonth(), 1), now);
  } else if (mode === 'backfill') {
    windows = monthChunks(new Date(now.getFullYear() - 1, now.getMonth(), 1), now);
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }

  const all = [];
  const problems = [];
  for (const platform of ['Instagram', 'Facebook']) {
    if (!CONFIG[platform].accountId && platform === 'Facebook') continue;
    try {
      for (const w of windows) all.push(...await fetchWindsor(platform, w));
    } catch (err) {
      problems.push(`${platform}: ${err.message}`);
      console.error(`${platform} pull failed:`, err.message);
    }
  }

  for (const p of all) Object.assign(p, resolve(p.caption), { last_synced: now.toISOString() });

  let upserted = 0;
  for (let i = 0; i < all.length; i += 500) {
    const batch = all.slice(i, i + 500);
    const { error } = await supabase.from('posts').upsert(batch, { onConflict: 'id' });
    if (error) throw error;
    upserted += batch.length;
  }

  const unresolved = all.filter((p) => !p.resort).length;
  const notes = [`${unresolved} posts unmatched`, ...problems].join(' | ');
  await supabase.from('sync_log').insert({ mode, rows_upserted: upserted, notes });

  return { mode, upserted, unresolved, problems };
}

// ---- Web handler: this is what the scheduler calls ----
export default async function handler(req, res) {
  if (!req.query.token || req.query.token !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  try {
    const result = await runSync(req.query.mode || 'recent');
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

