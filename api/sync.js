// GTC Social Performance sync: Windsor.ai -> tag -> Supabase
//   recent | reconcile | backfill  (see README)
// Re-runs never overwrite a label already decided by you or the AI.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const CONFIG = {
  Instagram: {
    connector: 'instagram', accountId: '17841404427634298', accountField: 'account_id',
    engagementField: 'media_engagement',
    timeFields: ['media_timestamp','timestamp','created_time','media_created_time','media_publish_time'],
    fields: { id:'media_id', date:'date', permalink:'media_url', caption:'media_caption',
      reach:'media_reach', impressions:'media_impressions', likes:'media_like_count',
      comments:'media_comments_count', saves:'media_saved', shares:'media_shares' }
  },
  Facebook: {
    connector: 'facebook_organic', accountId: '984913224898857', accountField: 'page_id',
    engagementField: null,
    timeFields: ['post_created_time','created_time'],
    fields: { id:'post_id', date:'date', permalink:'permalink_url', caption:'message',
      reach:'post_impressions_unique', impressions:'post_impressions', likes:'post_reactions_like_total',
      comments:'post_comments', saves:'post_saves', shares:'post_shares' }
  }
};

const num = (v)=>{const n=Number(v);return Number.isFinite(n)?Math.round(n):0;};
const iso = (d)=>d.toISOString().slice(0,10);
function monthChunks(from,to){const c=[];let cur=new Date(from.getFullYear(),from.getMonth(),1);
  while(cur<=to){const s=new Date(cur);const e=new Date(cur.getFullYear(),cur.getMonth()+1,0);
    c.push({from:s<from?from:s,to:e>to?to:e});cur=new Date(cur.getFullYear(),cur.getMonth()+1,1);}return c;}

async function fetchWindsor(platform, window){
  const cfg=CONFIG[platform]; const fieldMap={...cfg.fields}; let engField=cfg.engagementField;
  let timeFields=[...(cfg.timeFields||[])];
  for(let attempt=0;attempt<6;attempt++){
    const names=[...new Set([...Object.values(fieldMap),...timeFields])]; if(engField&&!names.includes(engField))names.push(engField);
    const params=new URLSearchParams({api_key:process.env.WINDSOR_API_KEY,fields:names.join(',')});
    if(cfg.accountId)params.set('filter',JSON.stringify([[cfg.accountField,'eq',cfg.accountId]]));
    if(window.recent){params.set('refresh_since','3d');params.set('refresh_interval','3h');}
    else{params.set('date_from',iso(window.from));params.set('date_to',iso(window.to));}
    const res=await fetch(`https://connectors.windsor.ai/${cfg.connector}?${params.toString()}`);
    if(res.ok){
      const json=await res.json(); const rows=json.data||json||[]; const f=fieldMap;
      return rows.map((r)=>{const likes=num(r[f.likes]),comments=num(r[f.comments]),saves=num(r[f.saves]),shares=num(r[f.shares]);
        const eng=engField?num(r[engField]):0;
        const t=timeFields.map(n=>r[n]).find(v=>v!==undefined&&v!==null&&v!=='');
        return {id:String(r[f.id]),platform,posted_at:new Date(t||r[f.date]).toISOString(),
          permalink:r[f.permalink]||null,caption:r[f.caption]||'',reach:num(r[f.reach]),impressions:num(r[f.impressions]),
          likes,comments,saves,shares,engagement:eng>0?eng:(likes+comments+saves+shares)};
      }).filter((p)=>p.id&&p.id!=='undefined');
    }
    const body=await res.text(); const m=body.match(/Unexpected field\(s\):\s*\{([^}]*)\}/i);
    if(res.status===400&&m){const bad=m[1].split(',').map(s=>s.trim().replace(/['"]/g,''));
      for(const[role,name]of Object.entries(fieldMap))if(bad.includes(name))delete fieldMap[role];
      timeFields=timeFields.filter(n=>!bad.includes(n));
      if(engField&&bad.includes(engField))engField=null; continue;}
    throw new Error(`${platform} Windsor error ${res.status}: ${body}`);
  }
  throw new Error(`${platform}: could not agree a supported field set`);
}

async function buildResolver(){
  const [{data:cr},{data:rl}]=await Promise.all([
    supabase.from('country_region').select('country,region'),
    supabase.from('resort_lookup').select('name,country,aliases')]);
  const reg=Object.fromEntries((cr||[]).map(x=>[x.country,x.region]));
  const resorts=(rl||[]).map(x=>({name:x.name,country:x.country,region:reg[x.country]||null,
    aliases:(x.aliases&&x.aliases.length?x.aliases:[x.name.toLowerCase()])}));
  return (caption)=>{const c=(caption||'').toLowerCase();
    for(const r of resorts)for(const a of r.aliases)if(a&&c.includes(a))return {resort:r.name,country:r.country,region:r.region};
    return {resort:null,country:null,region:null};};
}

async function runSync(opts={}){
  const {mode='recent',from,to}=opts;
  const resolve=await buildResolver(); const now=new Date();
  let windows;
  if(from&&to)windows=monthChunks(new Date(from),new Date(to));
  else if(mode==='recent')windows=[{recent:true}];
  else if(mode==='reconcile')windows=monthChunks(new Date(now.getFullYear(),now.getMonth(),1),now);
  else if(mode==='backfill')windows=monthChunks(new Date(now.getFullYear()-1,now.getMonth(),1),now);
  else throw new Error('Unknown mode: '+mode);
  const label=(from&&to)?'range':mode;

  const all=[]; const problems=[];
  for(const platform of ['Instagram','Facebook']){
    if(!CONFIG[platform].accountId&&platform==='Facebook')continue;
    try{for(const w of windows)all.push(...await fetchWindsor(platform,w));}
    catch(err){problems.push(`${platform}: ${err.message}`);console.error(platform,err.message);}
  }

  // Load existing decisions so re-syncs never wipe your or the AI's labels.
  const existing={}; const ids=all.map(p=>p.id);
  for(let i=0;i<ids.length;i+=400){
    const { data }=await supabase.from('posts').select('id,resort,country,region,reviewed,ai_checked').in('id',ids.slice(i,i+400));
    (data||[]).forEach(r=>existing[r.id]=r);
  }
  for(const p of all){
    const ex=existing[p.id];
    if(ex&&ex.reviewed){p.resort=ex.resort;p.country=ex.country;p.region=ex.region;p.reviewed=ex.reviewed;p.ai_checked=ex.ai_checked;}
    else{const r=resolve(p.caption);p.resort=r.resort;p.country=r.country;p.region=r.region;p.reviewed=ex?ex.reviewed:false;p.ai_checked=ex?ex.ai_checked:false;}
    p.last_synced=now.toISOString();
  }
  // Facebook cross-posts inherit the destination of the Instagram post published at
  // the same time (within 30 minutes). Precise, so no more same-day mix-ups.
  const igTagged=all.filter(p=>p.platform==='Instagram'&&p.resort).map(p=>({t:new Date(p.posted_at).getTime(),dest:[p.resort,p.country,p.region]}));
  const WINDOW=30*60*1000;
  for(const p of all){
    if(p.platform==='Facebook'&&!p.resort&&!p.reviewed){
      const t=new Date(p.posted_at).getTime();
      const near=new Set(igTagged.filter(x=>Math.abs(x.t-t)<=WINDOW).map(x=>JSON.stringify(x.dest)));
      if(near.size===1){const[resort,country,region]=JSON.parse([...near][0]);p.resort=resort;p.country=country;p.region=region;}
    }
  }

  let upserted=0;
  for(let i=0;i<all.length;i+=500){
    const {error}=await supabase.from('posts').upsert(all.slice(i,i+500),{onConflict:'id'});
    if(error)throw error; upserted+=Math.min(500,all.length-i);
  }
  const byPlatform={};
  for(const p of all){byPlatform[p.platform]=byPlatform[p.platform]||{posts:0,tagged:0};byPlatform[p.platform].posts++;if(p.resort)byPlatform[p.platform].tagged++;}
  const unresolved=all.filter(p=>!p.resort).length;
  await supabase.from('sync_log').insert({mode:label,rows_upserted:upserted,notes:[`${unresolved} unmatched`,...problems].join(' | ')});
  return {mode:label,upserted,unresolved,byPlatform,problems};
}

export default async function handler(req,res){
  if(!req.query.token||req.query.token!==process.env.SYNC_SECRET)return res.status(401).json({error:'Unauthorised'});
  try{return res.status(200).json({ok:true,...await runSync({mode:req.query.mode,from:req.query.from,to:req.query.to})});}
  catch(err){console.error(err);return res.status(500).json({ok:false,error:String(err.message||err)});}
}
