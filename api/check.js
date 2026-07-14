// Read-only accuracy check for the Facebook <-> Instagram matching.
//
// IMPORTANT: this version tests the SAME method the live system uses
// (api/enrich): match each Facebook post to the Instagram post published
// within 40 seconds of it, closest-first, one Facebook post to one Instagram
// post. It then uses the few Facebook posts that DO have their own caption as
// an answer key -- it reads that caption with Claude to work out the true
// destination, and checks whether the time-match agrees.
//
// It changes NOTHING in the database. Just open:
//   /api/check?token=YOUR_SECRET
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const REGIONS = ['UK&I', 'Europe', 'International'];
const WINDOW = 40 * 1000; // 40 seconds -- identical to the live matcher

// Read one Facebook caption and work out its true destination (the answer key).
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

async function fetchAll(platform, cols) {
  let out = [], from = 0;
  while (true) {
    const { data, error } = await supabase.from('posts').select(cols).eq('platform', platform).range(from, from + 999);
    if (error) throw error;
    out = out.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

// Rebuild EXACTLY what the live matcher (api/enrich) would decide:
// fbId -> [resort, country, region], for every Facebook post that finds a twin.
function buildProposalsByTime(igRows, fbRows) {
  // Same Instagram pool the live matcher uses: has a destination and a real
  // timestamp (midnight = a date-only fallback, no usable time, so excluded).
  const ig = igRows
    .filter(p => p.resort && !p.posted_at.endsWith('T00:00:00.000Z'))
    .map(p => ({ t: new Date(p.posted_at).getTime(), dest: [p.resort, p.country, p.region] }));

  const fb = fbRows.map(p => ({ id: p.id, t: new Date(p.posted_at).getTime() }));

  // Every candidate pair within the window, then assign closest-first, 1:1.
  const pairs = [];
  for (let fi = 0; fi < fb.length; fi++) {
    for (let gi = 0; gi < ig.length; gi++) {
      const d = Math.abs(ig[gi].t - fb[fi].t);
      if (d <= WINDOW) pairs.push([d, fi, gi]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const usedF = new Set(), usedG = new Set(), map = {};
  for (const [, fi, gi] of pairs) {
    if (usedF.has(fi) || usedG.has(gi)) continue;
    usedF.add(fi); usedG.add(gi);
    map[fb[fi].id] = ig[gi].dest;
  }
  return map;
}

export default async function handler(req, res) {
  if (!req.query.token || req.query.token !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  try {
    const igRows = await fetchAll('Instagram', 'id,posted_at,resort,country,region');
    const fbRows = await fetchAll('Facebook', 'id,posted_at,resort,country,region,caption,reviewed');

    // Match the live pool: only auto-matchable (not hand-corrected) Facebook posts.
    const autoFb = fbRows.filter(p => !p.reviewed);
    const proposals = buildProposalsByTime(igRows, autoFb);

    // The answer key: Facebook posts that carry their own caption AND weren't
    // hand-set (so we're testing the automatic matcher, not a human decision).
    const captioned = fbRows.filter(p => p.caption && p.caption.trim() !== '' && !p.reviewed).slice(0, 50);

    let tested = 0, regionAgreed = 0, countryAgreed = 0, noProposal = 0, noTruth = 0;
    const disagreements = [], agreements = [];

    for (const p of captioned) {
      let truth = null;
      try { truth = await classify(p.caption); } catch (e) { continue; }
      if (!truth || truth.confidence !== 'high' || !REGIONS.includes(truth.region)) { noTruth++; continue; }

      const prop = proposals[p.id]; // [resort, country, region] or undefined
      if (!prop) { noProposal++; continue; } // no twin within 40s -> correctly left blank
      tested++;

      const regionOK = prop[2] === truth.region;
      const countryOK = prop[1] && truth.country && prop[1].toLowerCase() === truth.country.toLowerCase();
      if (regionOK) regionAgreed++;
      if (countryOK) countryAgreed++;

      const row = {
        caption: p.caption.slice(0, 70),
        matched_to: { resort: prop[0], country: prop[1], region: prop[2] },
        caption_says: { resort: truth.resort, country: truth.country, region: truth.region },
        region_ok: regionOK, country_ok: countryOK
      };
      if (regionOK && countryOK) { if (agreements.length < 5) agreements.push(row); }
      else disagreements.push(row);
    }

    return res.status(200).json({
      ok: true,
      what_this_tested: 'The live 40-second closest-first Facebook-to-Instagram matching.',
      facebook_posts_total: fbRows.length,
      facebook_matched_to_an_instagram_post: Object.keys(proposals).length,
      facebook_left_blank_no_twin: autoFb.length - Object.keys(proposals).length,
      answer_key_size: captioned.length,
      tested,
      region_accuracy_percent: tested ? Math.round((regionAgreed / tested) * 100) : null,
      country_accuracy_percent: tested ? Math.round((countryAgreed / tested) * 100) : null,
      captioned_but_no_match_found: noProposal,
      caption_too_vague_to_judge: noTruth,
      disagreements,           // every mismatch, so we can see exactly what's wrong
      agreements_sample: agreements
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
