// AI caption reader. Reads a batch of untagged Instagram captions with Claude,
// auto-tags the confident ones, teaches the lookup so repeats are free next time,
// and leaves the genuinely unsure ones in the manual queue.
//   /api/enrich?token=YOUR_SECRET&limit=30
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const REGIONS = ['UK&I', 'Europe', 'International'];

async function classify(caption) {
  const system = 'You identify which golf-travel destination a Golf Travel Centre social media caption is about. You know where golf resorts, courses, towns and regions are in the world. Respond with minified JSON only, no other text.';
  const user =
    'Caption:\n"""' + caption + '"""\n\n' +
    'Return JSON exactly like {"resort":string|null,"country":string|null,"region":"UK&I"|"Europe"|"International"|null,"confidence":"high"|"medium"|"low"}.\n' +
    '- resort: the specific resort, course or hotel if one is named, otherwise null.\n' +
    '- country: the country the destination is in.\n' +
    '- region: "UK&I" for the UK and Ireland, "Europe" for mainland Europe, "International" for everywhere else.\n' +
    '- Use confidence "high" only when you are genuinely sure of the location. If the caption is general golf content with no clear destination, return nulls with confidence "low".';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 200, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) throw new Error('AI ' + res.status + ': ' + (await res.text()));
  const j = await res.json();
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Link Facebook posts to Instagram by exact posting time. Cross-posts publish
// within ~20 seconds, so the window is tight and it refuses to guess when two
// different destinations sit close together.
async function fetchAllPosts(platform, onlyUntagged) {
  let out = [], from = 0;
  while (true) {
    let q = supabase.from('posts').select('id,posted_at,resort,country,region').eq('platform', platform);
    if (onlyUntagged) q = q.is('resort', null);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw error;
    out = out.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function linkFacebook() {
  // Clear earlier automatic links (but keep anything you fixed by hand) so the
  // tighter rules take effect on a re-run.
  await supabase.from('posts').update({ resort: null, country: null, region: null })
    .eq('platform', 'Facebook').eq('reviewed', false).not('resort', 'is', null);

  const ig = (await fetchAllPosts('Instagram', false))
    .filter(p => p.resort && !p.posted_at.endsWith('T00:00:00.000Z'))
    .map(p => ({ t: new Date(p.posted_at).getTime(), dest: [p.resort, p.country, p.region] }));
  const fb = await fetchAllPosts('Facebook', true);

  const WINDOW = 60 * 1000; // 60 seconds; true cross-posts are within ~20s
  // Build every candidate pair within the window, then match closest-first,
  // one Facebook post to one Instagram post. A stray post can't steal a
  // destination that already belongs to a nearer twin.
  const pairs = [];
  for (let fi = 0; fi < fb.length; fi++) {
    const t = new Date(fb[fi].posted_at).getTime();
    for (let gi = 0; gi < ig.length; gi++) {
      const d = Math.abs(ig[gi].t - t);
      if (d <= WINDOW) pairs.push([d, fi, gi]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const usedF = new Set(), usedG = new Set(), assign = {};
  for (const [, fi, gi] of pairs) {
    if (usedF.has(fi) || usedG.has(gi)) continue;
    usedF.add(fi); usedG.add(gi);
    const dest = ig[gi].dest, k = JSON.stringify(dest);
    (assign[k] = assign[k] || { dest, ids: [] }).ids.push(fb[fi].id);
  }

  let updated = 0;
  for (const k of Object.keys(assign)) {
    const { dest, ids } = assign[k];
    for (let j = 0; j < ids.length; j += 200) {
      const { data, error } = await supabase.from('posts')
        .update({ resort: dest[0], country: dest[1], region: dest[2] })
        .in('id', ids.slice(j, j + 200)).select('id');
      if (error) throw error;
      updated += data ? data.length : 0;
    }
  }
  return updated;
}

// Collapse names that are clearly the same place (e.g. "Druids Glen" and
// "Druids Glen Golf Resort"), keeping the shortest as the display name.
const SUFFIXES = ['golf and country club', 'golf & country club', 'country club', 'golf resort', 'golf club', 'golf links', 'golf course', 'resort and spa', 'resort & spa', 'resort', 'links', 'gc'];
function canonical(name) {
  let c = String(name).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const s of SUFFIXES) if (c.endsWith(' ' + s)) { c = c.slice(0, c.length - s.length).trim(); break; }
  return c;
}
async function mergeDuplicates() {
  const rows = await fetchAllPosts('Instagram', false).then(a => a.concat());
  const all = rows.concat(await fetchAllPosts('Facebook', false));
  const groups = {};
  for (const r of all) {
    if (!r.resort) continue;
    const key = (r.country || '') + '|' + canonical(r.resort);
    (groups[key] = groups[key] || new Set()).add(r.resort);
  }
  let merged = 0;
  for (const k of Object.keys(groups)) {
    const names = [...groups[k]];
    if (names.length < 2) continue;
    const display = names.slice().sort((a, b) => a.length - b.length)[0];
    for (const nm of names) {
      if (nm === display) continue;
      const { data, error } = await supabase.from('posts').update({ resort: display }).eq('resort', nm).select('id');
      if (error) throw error;
      merged += data ? data.length : 0;
    }
  }
  return merged;
}

export default async function handler(req, res) {
  if (!req.query.token || req.query.token !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 50);
    const { data: posts, error } = await supabase.from('posts')
      .select('id,caption')
      .eq('platform', 'Instagram').is('resort', null).eq('ai_checked', false).neq('caption', '')
      .order('posted_at', { ascending: false }).limit(limit);
    if (error) throw error;

    let tagged = 0;
    for (const p of (posts || [])) {
      let r = null;
      try { r = await classify(p.caption); }
      catch (e) { continue; } // leave unchecked so it retries next run
      const upd = { ai_checked: true };
      if (r && r.confidence === 'high' && REGIONS.includes(r.region) && (r.resort || r.country)) {
        upd.resort = r.resort || r.country;
        upd.country = r.country || null;
        upd.region = r.region;
        upd.reviewed = true;
        tagged++;
        if (r.country) await supabase.from('country_region').upsert({ country: r.country, region: r.region }, { onConflict: 'country' });
        if (r.resort && r.country) {
          const { data: exists } = await supabase.from('resort_lookup').select('id').eq('name', r.resort).limit(1);
          if (!exists || !exists.length) await supabase.from('resort_lookup').insert({ name: r.resort, country: r.country, aliases: [String(r.resort).toLowerCase()] });
        }
      }
      await supabase.from('posts').update(upd).eq('id', p.id);
    }

    const { count } = await supabase.from('posts').select('id', { count: 'exact', head: true })
      .eq('platform', 'Instagram').is('resort', null).eq('ai_checked', false).neq('caption', '');

    // Once every caption has been read, link Facebook and tidy duplicate names.
    let linked = 0, merged = 0;
    if ((count || 0) === 0) { linked = await linkFacebook(); merged = await mergeDuplicates(); }

    return res.status(200).json({ ok: true, processed: (posts || []).length, tagged, linked, merged, remaining: count || 0, done: (count || 0) === 0 });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
