// Returns every post for the dashboard to read. Same-origin, so the
// dashboard page can fetch it directly. Uses the server-side key.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

export default async function handler(req, res) {
  try {
    const cols = 'id,platform,posted_at,permalink,resort,country,region,reach,impressions,engagement';
    let posts = [];
    let from = 0;
    const step = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('posts').select(cols)
        .order('posted_at', { ascending: true })
        .range(from, from + step - 1);
      if (error) throw error;
      posts = posts.concat(data || []);
      if (!data || data.length < step) break;
      from += step;
    }
    const { data: log } = await supabase
      .from('sync_log').select('ran_at').order('ran_at', { ascending: false }).limit(1);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ posts, lastSynced: log && log[0] ? log[0].ran_at : null });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
