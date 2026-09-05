import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const DEFAULT_BASE =
  'https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net';

function ravenBase() {
  const raw = (process.env.RAVEN_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  return raw.replace(/\/api$/i, '');
}

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  // Если сам объект — завершённый проект
  if (json.complete === true && (json.buildId || json.buildName || json.name)) return [json];
  if (Array.isArray(json.projects)) return json.projects;
  if (json.buildId || json.buildName) return [json];
  return [];
}

async function ravenGet(path) {
  const res = await fetch(ravenBase() + path, {
    headers: { Accept: 'application/json', 'User-Agent': 'ed-ring-colony/1.0' },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: res.ok, json, status: res.status };
}

function compute(project) {
  const commodities = project?.commodities && typeof project.commodities === 'object' ? project.commodities : {};
  const remaining = Object.values(commodities).reduce((s, n) => s + (Number(n) || 0), 0);
  const sumNeed = Number(project.sumNeed ?? remaining) || remaining;
  const sumTotal = Number(project.sumTotal ?? project.maxNeed ?? 0) || 0;
  const total = sumTotal > 0 ? sumTotal : sumNeed;
  const complete = Boolean(project.complete || project.status === 'done');
  const progress = complete
    ? 100
    : total > 0
      ? Math.min(100, Math.round(((total - sumNeed) / total) * 10000) / 100)
      : null;
  return { progress, sumNeed, sumTotal: total, complete, commodities };
}

async function fetchSystem(systemName) {
  const enc = encodeURIComponent(systemName);
  const [active, done] = await Promise.all([
    ravenGet('/api/system/' + enc),
    ravenGet('/api/system/' + enc + '/complete'),
  ]);

  // Если API явно говорит, что система завершена (на уровне ответа)
  const systemIsComplete =
    active.json?.complete === true ||
    active.json?.status === 'done' ||
    done.json?.complete === true ||
    done.json?.status === 'done' ||
    active.json?.progress === 100 ||
    done.json?.progress === 100;

  const list = [...asArray(active.json), ...asArray(done.json)];
  const projects = [];
  for (const raw of list) {
    let row = raw;
    if ((!row.commodities || !Object.keys(row.commodities).length) && row.buildId) {
      const full = await ravenGet('/api/project/' + encodeURIComponent(row.buildId));
      if (full.ok && full.json) row = full.json;
    }
    const c = compute(row);
    projects.push({ ...row, ...c });
  }

  const need = projects.reduce((s, p) => s + (p.sumNeed || 0), 0);
  const total = projects.reduce((s, p) => s + (p.sumTotal || p.sumNeed || 0), 0);

  let progress;
  if (systemIsComplete || (projects.length && projects.every((p) => p.complete))) {
    progress = 100;
  } else if (total > 0) {
    progress = Math.min(100, Math.round(((total - need) / total) * 10000) / 100);
  } else {
    progress = null;
  }

  return {
    system_name: systemName,
    progress,
    updated_at: new Date().toISOString(),
    data: {
      siteName: projects[0]?.buildName ?? active.json?.siteName ?? done.json?.siteName ?? null,
      architectName: projects.find((p) => p.architectName)?.architectName ?? active.json?.architectName ?? done.json?.architectName ?? null,
      projects: projects.map((p) => ({
        buildId: p.buildId || p.id || '',
        buildName: p.buildName || p.name || 'Unknown',
        buildType: p.buildType ?? null,
        complete: p.complete,
        progress: p.progress ?? 0,
        bodyName: p.bodyName ?? null,
        resources: Object.entries(p.commodities || {}).map(([name, remaining]) => {
          const rest = Number(remaining) || 0;
          const req = p.sumTotal > 0 && p.sumNeed > 0 ? Math.round(p.sumTotal * (rest / p.sumNeed)) : rest;
          return { name, key: name, required: req || rest, provided: Math.max(0, req - rest), remaining: rest };
        }),
      })),
      source: 'ravencolonial',
    },
  };
}

async function upsertProgress(row) {
  const { error: upErr } = await supabase.from('system_progress').upsert({
    system_name: row.system_name,
    progress: row.progress,
    updated_at: row.updated_at,
    data: row.data,
  });
  if (upErr) console.error(row.system_name, upErr.message);
  else console.log(row.system_name, row.progress ?? 'n/a');
}

const { data: hubs, error } = await supabase.from('hubs').select('id,system_name,status');
if (error) { console.error(error); process.exit(1); }

for (const h of hubs ?? []) {
  const row = await fetchSystem(h.system_name);
  await upsertProgress(row);
  if (row.progress != null) {
    const status = row.progress >= 100 ? 'done' : row.progress > 0 ? 'building' : h.status;
    await supabase.from('hubs').update({ progress: row.progress, status }).eq('id', h.id);
  }
}

const hubNames = new Set((hubs ?? []).map((h) => String(h.system_name).toLowerCase()));
const { data: route, error: routeErr } = await supabase
  .from('route_systems')
  .select('id,system_name,status')
  .order('sort_order')
  .order('id');

if (routeErr) {
  console.warn('route_systems:', routeErr.message);
} else {
  for (const r of route ?? []) {
    if (hubNames.has(String(r.system_name).toLowerCase())) continue;
    const row = await fetchSystem(r.system_name);
    await upsertProgress(row);
    if (row.progress != null) {
      const status = row.progress >= 100 ? 'done' : row.progress > 0 ? 'building' : (r.status || 'planned');
      await supabase.from('route_systems').update({ progress: row.progress, status }).eq('id', r.id);
      console.log('  route:', r.system_name, status, row.progress + '%');
    }
  }
}
