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

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = nonNegativeNumber(value);
    if (number != null && number > 0) return number;
  }
  return null;
}

function compute(project) {
  const commodities = project?.commodities && typeof project.commodities === 'object' ? project.commodities : {};
  const commoditiesRemaining = Object.values(commodities)
    .reduce((sum, value) => sum + (nonNegativeNumber(value) ?? 0), 0);
  // Raven's commodities/sumNeed fields describe cargo still needed, not the
  // original amount for each commodity. Do not turn them into an invented
  // commodity-level required/provided split.
  const sumNeed = nonNegativeNumber(project?.sumNeed ?? project?.remainingNeed) ?? commoditiesRemaining;
  const sumTotal = firstPositiveNumber(project?.sumTotal, project?.maxNeed, project?.maxRequired);
  const status = typeof project?.status === 'string' ? project.status.toLowerCase() : '';
  const complete = Boolean(project?.complete || project?.ConstructionComplete || ['done', 'complete', 'completed'].includes(status));
  const totalRemaining = complete ? 0 : sumNeed;
  const totalProvided = sumTotal == null ? null : Math.max(0, sumTotal - totalRemaining);
  const progress = complete
    ? 100
    : sumTotal != null && sumTotal > 0
      ? Math.min(100, Math.round((totalProvided / sumTotal) * 10000) / 100)
      : null;
  return {
    progress,
    sumNeed: totalRemaining,
    sumTotal,
    totalRequired: sumTotal,
    totalProvided,
    totalRemaining,
    complete,
    commodities,
  };
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

  const totalRemaining = projects.reduce((sum, project) => sum + project.totalRemaining, 0);
  const hasKnownTotals = projects.length > 0 && projects.every(
    (project) => project.totalRequired != null && project.totalProvided != null,
  );
  const totalRequired = hasKnownTotals
    ? projects.reduce((sum, project) => sum + project.totalRequired, 0)
    : null;
  const totalProvided = hasKnownTotals
    ? projects.reduce((sum, project) => sum + project.totalProvided, 0)
    : null;

  let progress;
  if (systemIsComplete || (projects.length && projects.every((project) => project.complete))) {
    progress = 100;
  } else if (totalRequired != null && totalRequired > 0 && totalProvided != null) {
    progress = Math.min(100, Math.round((totalProvided / totalRequired) * 10000) / 100);
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
        marketId: p.marketId == null ? null : String(p.marketId),
        buildName: p.buildName || p.name || 'Unknown',
        buildType: p.buildType ?? null,
        complete: p.complete,
        progress: p.progress ?? 0,
        bodyName: p.bodyName ?? null,
        totalRequired: p.totalRequired,
        totalProvided: p.totalProvided,
        totalRemaining: p.totalRemaining,
        resources: Object.entries(p.commodities || {}).map(([name, remaining]) => ({
          name,
          key: name,
          required: null,
          provided: null,
          remaining: nonNegativeNumber(remaining) ?? 0,
          exact: false,
        })),
      })),
      totalRequired,
      totalProvided,
      totalRemaining,
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
