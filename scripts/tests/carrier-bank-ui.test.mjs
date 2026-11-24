import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { bundleFile } from './helpers/bundle.mjs';
import { I18N_CONTEXT_STUB } from './helpers/i18nStub.mjs';

const { CarrierBankPanel } = await import(await bundleFile({
  entry: 'src/components/Carriers/CarrierBankPanel.tsx',
  stubs: { '@/lib/i18n/I18nContext': I18N_CONTEXT_STUB },
}));
const cargo = { items: [{ commodity: 'steel', name: 'Steel', quantity: 2640 }], trackedTotal: 2640, updatedAt: null };
const render = carrier => renderToStaticMarkup(React.createElement(CarrierBankPanel, { carrier }));
test('bank goods render for squadron member, not for public/personal views', () => {
  const carrier = { type: 'SquadronCarrier', relation: 'squadron', cargo };
  assert.match(render(carrier), /Steel/);
  assert.match(render(carrier), /squadron-bank/);
  assert.equal(render({ ...carrier, relation: 'public' }), '');
  assert.equal(render({ ...carrier, type: 'FleetCarrier' }), '');
  assert.equal(render(null), '');
});
