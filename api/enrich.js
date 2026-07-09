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

// Link Facebook posts to Instagram by pairing them in order within each day.
// Your team posts ~2 destinations a day, so single-destination matching misses most.
// Cross-posts publish in the same order, so 1st FB <-> 1st IG, 2nd <-> 2nd, etc.
async function linkFacebook() {
  const fetchAll = async (platform, onlyUntagged) => {
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
  };
  const ig = await fetchAll('Instagram', false);
  const fb = await fetchAll('Facebook', true);

  const day = (p) => p.posted_at.slice(0, 10);
  const igByDay = {}, fbByDay = {};
  for (const p of ig) (igByDay[day(p)] = igByDay[day(p)] || []).push(p);
  for (const p of fb) (fbByDay[day(p)] = fbByDay[day(p)] || []).push(p);

  // Collect assignments (destination -> list of Facebook ids) then bulk update.
  const assign = {};
  const add = (dest, id) => { const k = JSON.stringify(dest); (assign[k] = assign[k] || { dest, ids: [] }).ids.push(id); };

  for (const d of Object.keys(fbByDay)) {
    const igList = (igByDay[d] || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    const fbList = fbByDay[d].slice().sort((a, b) => new Date(a.posted_at) - new Date(b.posted_at));
    if (igList.length === fbList.length && igList.length > 0) {
      for (let i = 0; i < fbList.length; i++) if (igList[i].resort) add([igList[i].resort, igList[i].country, igList[i].region], fbList[i].id);
    } else {
      const dests = new Set(igList.filter(x => x.resort).map(x => JSON.stringify([x.resort, x.country, x.region])));
      if (dests.size === 1) { const dd = JSON.parse([...dests][0]); for (const f of fbList) add(dd, f.id); }
    }
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

    // Once every caption has been read, link Facebook across the whole history.
    let linked = 0;
    if ((count || 0) === 0) linked = await linkFacebook();

    return res.status(200).json({ ok: true, processed: (posts || []).length, tagged, linked, remaining: count || 0, done: (count || 0) === 0 });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
