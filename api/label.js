// Labelling helper.
//  GET  /api/label            -> untagged posts + the resort/country lists
//  POST /api/label            -> save a label, or mark a post as "not a destination"
//                                (POST needs your password in the body as "token")
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const [{ data: countries }, { data: resorts }] = await Promise.all([
        supabase.from('country_region').select('country,region').order('country'),
        supabase.from('resort_lookup').select('name,country').order('name')
      ]);
      const { data: untagged, error } = await supabase
        .from('posts')
        .select('id,platform,posted_at,caption,permalink')
        .is('resort', null)
        .eq('reviewed', false)
        .order('posted_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      const { count } = await supabase
        .from('posts').select('id', { count: 'exact', head: true })
        .is('resort', null).eq('reviewed', false);
      return res.status(200).json({
        untagged: untagged || [], remaining: count || 0,
        resorts: resorts || [], countries: countries || []
      });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (!body.token || body.token !== process.env.SYNC_SECRET) {
        return res.status(401).json({ error: 'Wrong password' });
      }
      if (!body.id) return res.status(400).json({ error: 'Missing id' });

      if (body.action === 'skip') {
        const { error } = await supabase.from('posts').update({ reviewed: true }).eq('id', body.id);
        if (error) throw error;
        return res.status(200).json({ ok: true, id: body.id, action: 'skip' });
      }

      if (!body.resort || !body.country) return res.status(400).json({ error: 'Need a resort and country' });
      const { data: cr } = await supabase.from('country_region').select('region').eq('country', body.country).limit(1);
      const region = cr && cr[0] ? cr[0].region : null;

      const { error } = await supabase.from('posts')
        .update({ resort: body.resort, country: body.country, region, reviewed: true })
        .eq('id', body.id);
      if (error) throw error;

      if (body.addToLookup) {
        // Remember this resort so future syncs tag it automatically. Ignore duplicates.
        await supabase.from('resort_lookup')
          .insert({ name: body.resort, country: body.country, aliases: [body.resort.toLowerCase()] });
      }
      return res.status(200).json({ ok: true, id: body.id, resort: body.resort, country: body.country, region });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
