// Read-only accuracy check for the Facebook order-matching.
// Uses the Facebook posts that DO have captions as an answer key: it works out
// their true destination from the caption, runs the order-matching in memory,
// and reports how often the two agree. Changes nothing in the database.
//   /api/check?token=YOUR_SECRET
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const REGIONS = ['UK&I', 'Europe', 'International'];

async function classify(caption) {
  const system = 'You identify which golf-travel destination a Golf Travel Centre social media caption is about. Respond with minified JSON only.';
  const user = 'Caption:\n"""' + caption + '"""\n\nReturn {"resort":string|null,"country":string|null,"region":"UK&I"|"Europe"|"International"|null,"confidence":"high"|"medium"|"low"}. UK&I = UK and Ireland; Europe = mainland Europe; International = rest of world. Nulls with "low" if no clear destination.';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 200, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) throw new Error('AI ' + res.status);
  const j = await res.json();
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

async function fetchAll(platform, extraCols) {
  let out = [], from = 0;
  while (true) {
    const { data, error } = await supabase.from('posts').select('id,posted_at,resort,country,region' + (extraCols || '')).eq('platform', platform).range(from, from + 999);
    if (error) throw error;
    out = out.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

// Build the order-match proposal: fbId -> [resort,country,region]
function buildProposals(ig, fb) {
  const day = (p) => p.posted_at.slice(0, 10);
  const igByDay = {}, fbByDay = {};
  for (const p of ig) (igByDay[day(p)] = igByDay[day(p)] || []).push(p);
  for (const p of fb) (fbByDay[day(p)] = fbByDay[day(p)] || []).push(p);
  const map = {};
  for (const d of Object.keys(fbByDay)) {
    const igList = (igByDay[d] || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    const fbList = fbByDay[d].slice().sort((a, b) => new Date(a.posted_at) - new Date(b.posted_at));
    if (igList.length === fbList.length && igList.length > 0) {
      for (let i = 0; i < fbList.length; i++) if (igList[i].resort) map[fbList[i].id] = [igList[i].resort, igList[i].country, igList[i].region];
    } else {
      const dests = new Set(igList.filter(x => x.resort).map(x => JSON.stringify([x.resort, x.country, x.region])));
      if (dests.size === 1) { const dd = JSON.parse([...dests][0]); for (const f of fbList) map[f.id] = dd; }
    }
  }
  return map;
}

export default async function handler(req, res) {
  if (!req.query.token || req.query.token !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  try {
    const ig = await fetchAll('Instagram');
    const fb = await fetchAll('Facebook', ',caption');
    const proposals = buildProposals(ig, fb.map(p => ({ id: p.id, posted_at: p.posted_at })));

    const captioned = fb.filter(p => p.caption && p.caption.trim() !== '').slice(0, 40);
    let tested = 0, agreed = 0, disagreed = 0, noProposal = 0;
    const examples = [];
    for (const p of captioned) {
      let truth = null;
      try { truth = await classify(p.caption); } catch (e) { continue; }
      if (!truth || !REGIONS.includes(truth.region)) continue; // can't establish truth
      const prop = proposals[p.id];
      if (!prop) { noProposal++; continue; }
      tested++;
      const agree = prop[2] === truth.region;
      if (agree) agreed++; else disagreed++;
      if (examples.length < 8) examples.push({
        caption: p.caption.slice(0, 60),
        true_region: truth.region,
        order_match_region: prop[2],
        agree
      });
    }
    return res.status(200).json({
      ok: true,
      facebook_with_captions: fb.filter(p => p.caption && p.caption.trim() !== '').length,
      tested, agreed, disagreed,
      captioned_without_a_proposal: noProposal,
      accuracy_percent: tested ? Math.round((agreed / tested) * 100) : null,
      examples
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
