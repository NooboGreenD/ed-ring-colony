import type { CarrierView } from './fleetCarriers';

/** Minimal private goods view: no market orders, finance or owner information. */
export type SquadronBankCarrier = Pick<CarrierView,
  'carrierId' | 'name' | 'callsign' | 'type' | 'relation' | 'cargo'>;

export function squadronBankCarriers(views: CarrierView[], squadronId: number): SquadronBankCarrier[] {
  return views
    .filter(view => view.type === 'SquadronCarrier' && view.squadronId === squadronId && view.relation === 'squadron')
    .map(({ carrierId, name, callsign, type, relation, cargo }) => ({ carrierId, name, callsign, type, relation, cargo }));
}
