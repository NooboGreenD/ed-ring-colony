import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { bundleFile } from './helpers/bundle.mjs';
import { I18N_CONTEXT_STUB } from './helpers/i18nStub.mjs';
import { buildCarrierView } from '../../src/lib/fleetCarriers.ts';
const {default:CarrierCard}=await import(await bundleFile({entry:'src/components/Carriers/CarrierCard.tsx',
  stubs:{'@/lib/i18n/I18nContext':I18N_CONTEXT_STUB,'next/link':`import React from 'react';export default function Link({href,children,...props}){return React.createElement('a',{href,...props},children)}`},external:['react','react-dom']}));
test('personal stock UI: show unknown-stock warning instead of a proven stale full commodity list',()=>{
 const carrier=buildCarrierView({carrier_id:'3700005632',carrier_type:'FleetCarrier',stats_at:'2026-03-04T11:00:00Z',space_usage:{cargo:2}},
  {relation:'own',showFinance:false,cargoRows:[{commodity:'steel',quantity:1301,observed_at:'2026-03-04T10:00:00Z'}]});
 const html=renderToStaticMarkup(React.createElement(CarrierCard,{carrier}));
 assert.match(html,/Поимённые остатки неизвестны/);assert.doesNotMatch(html,/1301|1.?301/);
});
