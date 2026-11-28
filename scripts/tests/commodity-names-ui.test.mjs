import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
import { buildProjectLeaders } from '../../src/lib/architect/projectLeaders.ts';

const I18N = `
import { useSyncExternalStore } from 'react';
import { translations } from '@/lib/i18n/translations';
let locale = 'ru'; const listeners = new Set<() => void>();
export function setTestLocale(next) { locale = next; listeners.forEach(fn => fn()); }
export function useI18n() {
  const current = useSyncExternalStore(fn => {listeners.add(fn); return () => listeners.delete(fn)}, () => locale);
  return {locale:current, t:(key, params = {}) => (translations[current][key] ?? key).replace(/\\{(\\w+)\\}/g, (m,n) => params[n] ?? m)};
}`;

test('leaderboard renders localized commodity names and updates every displayed slice when UI locale changes', async () => {
  const {JSDOM} = await import('jsdom');
  const bundle = await bundleFile({entrySource: `
export {default as Leaders} from '@/components/Architect/projects/ProjectLeaders';
export {setTestLocale} from '@/lib/i18n/I18nContext';`,
    stubs: {'@/lib/i18n/I18nContext': I18N}, external: ['react', 'react-dom', 'react-dom/client']});
  const view = buildProjectLeaders({
    rows: ['Auto-Fabricators', 'Building Fabricators'].map((commodity) => ({user_id:'pilot', target:'site', system_name:'Sol', market_id:'3900000001', station_name:'Port', commodity, tons:100, ops:1, first_at:null, last_at:null})),
    activity:[], pilots:new Map([['pilot', {name:'Test Pilot', member:true, role:'owner', hidden:false}]]),
    sites:new Map([['3900000001', {name:'Port', systemName:'Sol'}]]), carriers:new Map(), viewerId:'pilot',
  });
  const before = JSON.stringify(view);
  const dom = new JSDOM('<div id="root"></div>', {url:'https://example.test'});
  const saved = {};
  for (const key of ['window','document','HTMLElement','Node','IS_REACT_ACT_ENVIRONMENT']) {
    saved[key] = globalThis[key]; globalThis[key] = key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key];
  }
  const React = await import('react'); const {createRoot} = await import('react-dom/client');
  const mod = await import(bundle); const root = createRoot(dom.window.document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(mod.Leaders, {leaders:view, loading:false, error:'', period:'all', scope:'all', color:'#123456', onPeriod(){}, onScope(){}})));
    const doc = dom.window.document;
    const text = () => doc.body.textContent;
    assert.match(text(), /Автосинтезаторы/); assert.match(text(), /Строительные синтезаторы/);
    assert.doesNotMatch(text(), /Auto-Fabricators|Building Fabricators/);
    const pilot = [...doc.querySelectorAll('tr[aria-expanded]')][0]; assert.ok(pilot);
    await React.act(async () => pilot.dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true})));
    assert.ok([...doc.querySelectorAll('td')].some(el => el.textContent === 'Автосинтезаторы'));
    await React.act(async () => mod.setTestLocale('en'));
    assert.match(text(), /Auto-Fabricators/); assert.match(text(), /Building Fabricators/);
    assert.doesNotMatch(text(), /Автосинтезаторы|Строительные синтезаторы/);
    assert.ok([...doc.querySelectorAll('td')].some(el => el.textContent === 'Auto-Fabricators'));
    await React.act(async () => mod.setTestLocale('ru'));
    assert.match(text(), /Автосинтезаторы/); assert.doesNotMatch(text(), /Auto-Fabricators/);
    assert.equal(JSON.stringify(view), before);
  } finally {
    await React.act(async () => root.unmount()); dom.window.close(); Object.assign(globalThis, saved);
  }
});
