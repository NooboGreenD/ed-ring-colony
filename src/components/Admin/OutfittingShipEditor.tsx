'use client';
import { cloneElement, useId, useState, type ReactElement, type ReactNode } from 'react';
import { IconPlus, IconRefresh, IconSave, IconTrash, IconWrench } from '@/components/Icons';
import { isRecord, validateCatalogValue } from '@/lib/outfitting/catalog';
import { useI18n } from '@/lib/i18n/I18nContext';
import type { InternalSlot, OutfittingData, OutfittingShip, ShipProperties } from '@/lib/outfitting/types';
import { STANDARD_GROUPS } from '@/lib/outfitting/calc';
import type { CatalogEditorItem } from './OutfittingEditor';
import OutfittingDialog from './OutfittingDialog';
import styles from './OutfittingAdmin.module.css';

type Section = 'hardpoints' | 'internal';
type Tab = 'main' | 'specs' | 'slots' | 'json';
const TABS: Record<Tab, string> = { main: 'ofs.tabMain', specs: 'ofs.tabSpecs', slots: 'ofs.tabSlots', json: 'JSON' };
const SPECS: { key: keyof ShipProperties; label: string; optional?: boolean }[] = [
  { key: 'speed', label: 'ofs.specSpeed' }, { key: 'boost', label: 'ofs.specBoost' },
  { key: 'boostEnergy', label: 'ofs.specBoostEnergy' }, { key: 'boostInt', label: 'ofs.specBoostInt', optional: true },
  { key: 'baseShieldStrength', label: 'ofs.specBaseShield' }, { key: 'baseArmour', label: 'ofs.specBaseArmour' },
  { key: 'heatCapacity', label: 'ofs.specHeat' }, { key: 'hardness', label: 'ofs.specHardness' },
  { key: 'hullMass', label: 'ofs.specHullMass' }, { key: 'masslock', label: 'ofs.specMasslock' },
  { key: 'pipSpeed', label: 'ofs.specPipSpeed' }, { key: 'reserveFuelCapacity', label: 'ofs.specReserveFuel' },
  { key: 'minthrust', label: 'ofs.specMinthrust', optional: true },
  { key: 'pitch', label: 'ofs.specPitch', optional: true }, { key: 'roll', label: 'ofs.specRoll', optional: true },
  { key: 'yaw', label: 'ofs.specYaw', optional: true },
];

function Field({ label, hint, children, wide = false }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  const id = useId();
  return <div className={`${styles.field} ${wide ? styles.wideField : ''}`}>
    <label htmlFor={id}>{label}</label>
    {cloneElement(children as ReactElement<{ id?: string; 'aria-describedby'?: string }>, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })}
    {hint && <small id={`${id}-hint`}>{hint}</small>}
  </div>;
}

function eligibleBuffers(ship: OutfittingShip): Record<string, string> {
  const result: Record<string, string> = {};
  for (const section of ['hardpoints', 'internal'] as const) {
    ship.slots[section].forEach((slot, index) => {
      if (typeof slot === 'object' && !slot.archived) result[`${section}:${index}`] = slot.eligible ? JSON.stringify(slot.eligible, null, 2) : '';
    });
  }
  return result;
}

/** JSON editing permits incomplete values, but never mount a form that would crash while rendering. */
function canRenderShip(value: OutfittingShip): boolean {
  if (typeof value.id !== 'string' || !isRecord(value.properties) || !isRecord(value.slots)
    || !isRecord(value.defaults) || !Array.isArray(value.bulkheads)
    || !value.bulkheads.every(isRecord)) return false;
  if (typeof value.properties.name !== 'string' || typeof value.properties.manufacturer !== 'string') return false;
  for (const section of ['standard', 'hardpoints', 'internal'] as const) {
    if (!Array.isArray(value.slots[section]) || !Array.isArray(value.defaults[section])) return false;
    if (!value.slots[section].every((slot: unknown) => typeof slot === 'number' || (section !== 'standard' && isRecord(slot)))) return false;
  }
  return true;
}

export default function OutfittingShipEditor({ item, data, onClose, onSave }: {
  item: CatalogEditorItem;
  data: OutfittingData;
  onClose: () => void;
  onSave: (key: string, value: OutfittingShip) => Promise<void>;
}) {
  const { t } = useI18n();
  const initial = item.value as OutfittingShip;
  const creating = item.mode === 'create';
  const [draft, setDraft] = useState<OutfittingShip>(() => structuredClone(initial));
  const [tab, setTab] = useState<Tab>('main');
  const [json, setJson] = useState(() => JSON.stringify(initial, null, 2));
  const [eligibleText, setEligibleText] = useState(() => eligibleBuffers(initial));
  const [showArchived, setShowArchived] = useState<Record<Section, boolean>>({ hardpoints: false, internal: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft)
    || JSON.stringify(eligibleBuffers(initial)) !== JSON.stringify(eligibleText)
    || (tab === 'json' && json !== JSON.stringify(initial, null, 2));

  const update = (change: (ship: OutfittingShip) => void) => {
    setDraft((previous) => { const next = structuredClone(previous); change(next); return next; });
    setError('');
  };
  const setProperty = (field: keyof ShipProperties, value: unknown) => update((ship) => {
    const props = ship.properties as unknown as Record<string, unknown>;
    if (value === undefined) delete props[field]; else props[field] = value;
  });
  const setSlot = (section: Section, index: number, value: InternalSlot) => update((ship) => { ship.slots[section][index] = value; });
  const setDefault = (section: Section | 'standard', index: number, value: string) => update((ship) => {
    // A few source ships omit empty trailing hardpoint defaults.
    while (ship.defaults[section].length < ship.slots[section].length) ship.defaults[section].push(0);
    ship.defaults[section][index] = value || 0;
  });
  const addSlot = (section: Section) => update((ship) => {
    if (ship.slots[section].length >= 64) return;
    ship.slots[section].push(1);
    while (ship.defaults[section].length < ship.slots[section].length) ship.defaults[section].push(0);
  });
  const removeSlot = (section: Section, index: number) => {
    const saved = !creating && index < initial.slots[section].length;
    const label = `${section === 'hardpoints' ? 'H' : 'I'}${index}`;
    const warning = saved
      ? t('ofs.removeSaved', { label })
      : t('ofs.removeNew', { label });
    if (!window.confirm(warning)) return;
    if (saved) {
      // Existing slots are archived, never spliced: build links use array indices.
      const original = data.ships[item.key]?.slots[section][index] ?? initial.slots[section][index];
      const stock = data.ships[item.key]?.defaults[section][index];
      update((ship) => {
        ship.slots[section][index] = typeof original === 'number' ? { class: original, archived: true } : { ...original, archived: true };
        if (stock !== undefined) ship.defaults[section][index] = stock;
      });
      setEligibleText((previous) => { const next = { ...previous }; delete next[`${section}:${index}`]; return next; });
    } else {
      // Only unsaved slots may be physically removed, including one in the middle.
      update((ship) => { ship.slots[section].splice(index, 1); ship.defaults[section].splice(index, 1); });
      setEligibleText((previous) => {
        const next: Record<string, string> = {};
        const prefix = `${section}:`;
        for (const [key, text] of Object.entries(previous)) {
          if (!key.startsWith(prefix)) { next[key] = text; continue; }
          const position = Number(key.slice(prefix.length));
          if (position !== index) next[`${prefix}${position > index ? position - 1 : position}`] = text;
        }
        return next;
      });
    }
  };
  const restoreSlot = (section: Section, index: number) => {
    const slot = draft.slots[section][index];
    if (typeof slot === 'number' || !slot.archived) return;
    const restored = { ...slot }; delete restored.archived;
    update((ship) => { ship.slots[section][index] = Object.keys(restored).length === 1 ? restored.class : restored; });
    if (Object.keys(restored).length > 1) setEligibleText((previous) => ({ ...previous,
      [`${section}:${index}`]: restored.eligible ? JSON.stringify(restored.eligible, null, 2) : '' }));
  };
  const toggleSpecial = (section: Section, index: number) => {
    const current = draft.slots[section][index];
    if (typeof current === 'number') {
      const group = section === 'hardpoints' ? (current === 0 ? 'sb' : 'pl') : 'hr';
      const slot = { class: current, name: 'Special', eligible: { [group]: 1 } };
      setSlot(section, index, slot);
      setEligibleText((previous) => ({ ...previous, [`${section}:${index}`]: JSON.stringify(slot.eligible, null, 2) }));
    } else {
      setSlot(section, index, current.class);
      setEligibleText((previous) => { const next = { ...previous }; delete next[`${section}:${index}`]; return next; });
    }
  };

  const prepare = (): OutfittingShip => {
    if (tab === 'json') {
      const parsed: unknown = JSON.parse(json);
      if (!isRecord(parsed)) throw new Error(t('ofs.jsonObject'));
      return parsed as unknown as OutfittingShip;
    }
    const value = structuredClone(draft);
    // Armour is edited in its own catalogue. After a revision conflict its
    // latest snapshot may differ from the open hull form; keep the hull draft
    // while retrying against the current armour instead of overwriting it.
    if (!creating && data.ships[item.key]) value.bulkheads = structuredClone(data.ships[item.key].bulkheads);
    for (const section of ['hardpoints', 'internal'] as const) {
      value.slots[section].forEach((slot, index) => {
        if (typeof slot !== 'object' || slot.archived) return;
        const raw = eligibleText[`${section}:${index}`]?.trim();
        if (!raw) delete slot.eligible;
        else slot.eligible = JSON.parse(raw);
      });
    }
    return value;
  };
  const changeTab = (next: Tab) => {
    try {
      const value = prepare();
      if (tab === 'json' && next !== 'json' && !canRenderShip(value)) {
        throw new Error(t('ofs.fillRequired'));
      }
      setDraft(value);
      setEligibleText(eligibleBuffers(value));
      if (next === 'json') setJson(JSON.stringify(value, null, 2));
      setTab(next); setError('');
    } catch { setError(t('ofs.jsonSlotsFix')); }
  };
  const requestClose = () => {
    if (!busy && (!dirty || window.confirm(t('ofs.confirmClose')))) onClose();
  };
  const submit = async () => {
    setError('');
    try {
      const value = prepare();
      const key = creating ? value.id : item.key;
      const validated = validateCatalogValue('ship', key, value, data) as OutfittingShip;
      setBusy(true);
      await onSave(key, validated);
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('ofs.saveFailed')); }
    finally { setBusy(false); }
  };

  const slotList = (section: Section) => {
    const archivedCount = draft.slots[section].filter((slot) => typeof slot !== 'number' && slot.archived).length;
    return <div className={styles.slotSection} key={section}>
    <div className={styles.slotHeading}><h3>{section === 'hardpoints' ? t('ofs.hardpoints') : t('ofs.internal')}</h3>
      <button type="button" className={styles.secondaryButton} disabled={draft.slots[section].length >= 64} onClick={() => addSlot(section)}><IconPlus size={14} color="currentColor" /> {t('ofs.addSlot')}</button></div>
    <p className={styles.helpText}>{t('ofs.slotHelp')}</p>
    {archivedCount > 0 && <button type="button" className={styles.quietButton} aria-expanded={showArchived[section]}
      onClick={() => setShowArchived((previous) => ({ ...previous, [section]: !previous[section] }))}>
      {showArchived[section] ? t('ofs.hideArchived') : t('ofs.showArchived', { count: archivedCount })}
    </button>}
    {draft.slots[section].map((slot, index) => {
      const label = `${section === 'hardpoints' ? 'H' : 'I'}${index}`;
      const archived = typeof slot !== 'number' && slot.archived;
      if (archived) return showArchived[section] ? <div key={index} className={`${styles.slotRow} ${styles.deletedSlotRow}`}>
        <strong>{label}</strong><span className={styles.slotGroup}>{t('ofs.archivedSlot', { size: slot.class })}{slot.name ? ` · ${slot.name}` : ''}</span>
        <button type="button" className={styles.restoreButton} aria-label={t('ofs.restoreSlot', { section, index })} onClick={() => restoreSlot(section, index)}><IconRefresh size={14} color="currentColor" /> {t('ofa.restoreLabel')}</button>
        {(creating || index >= initial.slots[section].length) && <button type="button" className={styles.iconButton} aria-label={t('ofs.deleteSlotAria', { section, index })} title={t('ofs.deleteSlotForever')} onClick={() => removeSlot(section, index)}><IconTrash size={15} color="currentColor" /></button>}
      </div> : null;
      const special = typeof slot === 'object';
      return <div key={index} className={styles.slotRow}>
        <strong>{section === 'hardpoints' ? 'H' : 'I'}{index}</strong>
        <label>{t('ofa.size')}<select aria-label={t('ofs.sizeAria', { section, index })} value={special ? slot.class : slot} onChange={(event) => setSlot(section, index, special ? { ...slot, class: Number(event.target.value) } : Number(event.target.value))}>
          {Array.from({ length: section === 'hardpoints' ? 5 : 8 }, (_, size) => <option key={size} value={section === 'hardpoints' ? size : size + 1}>{section === 'hardpoints' ? size : size + 1}</option>)}
        </select></label>
        <label>{t('ofs.factoryModule')}<input aria-label={t('ofs.factoryAria', { section, index })} value={String(draft.defaults[section][index] ?? '')} placeholder={t('ofs.moduleIdPlaceholder')} maxLength={64}
          onChange={(event) => setDefault(section, index, event.target.value)} /></label>
        <label className={styles.slotToggle}><input type="checkbox" checked={special} onChange={() => toggleSpecial(section, index)} /> {t('ofs.special')}</label>
        <button type="button" className={styles.iconButton} aria-label={t('ofs.deleteSlotAria', { section, index })} title={t('ofs.deleteSlotTitle')} onClick={() => removeSlot(section, index)}><IconTrash size={15} color="currentColor" /></button>
        {special && <div className={styles.slotSpecial}>
          <Field label={t('ofs.slotPurpose')}><input value={slot.name ?? ''} maxLength={80} placeholder="Military / Mining / Cargo" onChange={(event) => setSlot(section, index, { ...slot, name: event.target.value })} /></Field>
          <Field label={t('ofs.allowedGroups')} hint={t('ofs.allowedHint')}>
            <textarea rows={3} className={styles.codeInput} spellCheck={false} value={eligibleText[`${section}:${index}`] ?? ''}
              onChange={(event) => { setEligibleText((previous) => ({ ...previous, [`${section}:${index}`]: event.target.value })); setError(''); }} />
          </Field>
        </div>}
      </div>;
    })}
  </div>;
  };

  return <OutfittingDialog title={creating ? t('ofs.titleAdd') : t('ofs.titleEdit')} eyebrow={creating ? t('ofs.dialogNew') : item.key} onClose={requestClose} busy={busy}>
    <form className={styles.editorForm} onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
      <div className={styles.editorTabs} role="tablist" aria-label={t('ofs.paramsAria')}>
        {(Object.keys(TABS) as Tab[]).map((key) => <button type="button" role="tab" aria-selected={tab === key} aria-controls="ship-editor-panel" key={key}
          disabled={busy} className={tab === key ? styles.activeTab : styles.tabButton} onClick={() => changeTab(key)}>{t(TABS[key])}</button>)}
      </div>
      <div key={tab} className={styles.editorScroll} role="region" aria-label={t('ofs.contentAria')} tabIndex={0}>
        <fieldset disabled={busy} className={styles.editorBody} id="ship-editor-panel" role="tabpanel" aria-label={t(TABS[tab])}>
        {tab === 'main' && <>
          <div className={styles.note}><IconWrench size={16} color="currentColor" /><span>{t('ofs.templateNote')}</span></div>
          <div className={styles.formGrid}>
            <Field label={t('ofs.shipId')} hint={t('ofs.shipIdHint')}>
              <input data-autofocus autoFocus required disabled={!creating} pattern="[a-z][a-z0-9_\-]{0,63}" maxLength={64} value={draft.id} onChange={(event) => update((ship) => { ship.id = event.target.value; })} />
            </Field>
            <Field label={t('ofs.shipName')}><input required maxLength={160} value={draft.properties.name} onChange={(event) => setProperty('name', event.target.value)} /></Field>
            <Field label={t('ofa.manufacturer')}><input required maxLength={120} value={draft.properties.manufacturer} onChange={(event) => setProperty('manufacturer', event.target.value)} /></Field>
            <Field label={t('ofs.hullSize')}><select value={draft.properties.class} onChange={(event) => setProperty('class', Number(event.target.value))}>
              <option value={1}>{t('ofs.sizeSmallOpt')}</option><option value={2}>{t('ofs.sizeMediumOpt')}</option><option value={3}>{t('ofs.sizeLargeOpt')}</option>
            </select></Field>
            <Field label={t('ofs.hullCost')}><input type="number" min={0} step="any" required value={draft.properties.hullCost} onChange={(event) => setProperty('hullCost', event.target.value === '' ? undefined : Number(event.target.value))} /></Field>
            <Field label={t('ofs.retailCost')}><input type="number" min={0} step="any" required value={draft.retailCost} onChange={(event) => update((ship) => { ship.retailCost = Number(event.target.value); })} /></Field>
            <Field label={t('ofs.crew')}><input type="number" min={1} max={16} step={1} required value={draft.properties.crew} onChange={(event) => setProperty('crew', event.target.value === '' ? undefined : Number(event.target.value))} /></Field>
            <label className={styles.checkField}><input type="checkbox" checked={draft.properties.fighterHangars === true} onChange={(event) => setProperty('fighterHangars', event.target.checked)} /><span>{t('ofs.fighterHangar')}</span></label>
            <label className={styles.checkField}><input type="checkbox" checked={draft.properties.luxuryCabins === true} onChange={(event) => setProperty('luxuryCabins', event.target.checked)} /><span>{t('ofs.luxuryCabins')}</span></label>
          </div>
          <p className={styles.helpText}>{t('ofs.armourCount', { count: draft.bulkheads.filter((entry) => !entry.archived).length })}</p>
        </>}
        {tab === 'specs' && <><div className={styles.note}>{t('ofs.specsNote')}</div>
          <div className={styles.formGrid}>{SPECS.map(({ key, label, optional }) => <Field key={key} label={t(label)}>
            <input type="number" min={key === 'hullMass' || key === 'pipSpeed' ? '0.000001' : 0} step="any" required={!optional}
              value={typeof draft.properties[key] === 'number' ? String(draft.properties[key]) : ''} placeholder={optional ? t('ofs.notSet') : undefined}
              onChange={(event) => setProperty(key, event.target.value === '' ? undefined : Number(event.target.value))} />
          </Field>)}</div>
        </>}
        {tab === 'slots' && <>
          <div className={styles.note}>{t('ofs.slotsNote')}</div>
          <div className={styles.slotSection}><div className={styles.slotHeading}><h3>{t('ofs.standardModules')}</h3><span className={styles.helpText}>{t('ofs.sevenSlots')}</span></div>
            {draft.slots.standard.map((size, index) => <div className={styles.slotRow} key={index}>
              <strong>S{index}</strong><span className={styles.slotGroup}>{data.groups[STANDARD_GROUPS[index]]?.name ?? STANDARD_GROUPS[index]}</span>
              <label>{t('ofa.size')}<select aria-label={t('ofs.standardSizeAria', { index })} value={size} onChange={(event) => update((ship) => { ship.slots.standard[index] = Number(event.target.value); })}>
                {Array.from({ length: 8 }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
              </select></label>
              <label>{t('ofs.factoryModule')}<input aria-label={t('ofs.standardFactoryAria', { index })} maxLength={64} value={String(draft.defaults.standard[index] ?? '')} onChange={(event) => setDefault('standard', index, event.target.value)} /></label>
            </div>)}
          </div>
          {slotList('hardpoints')}{slotList('internal')}
        </>}
        {tab === 'json' && <><div className={styles.note}>{t('ofs.jsonNote')}</div>
          <Field label={t('ofs.jsonLabel')} wide><textarea className={styles.codeInput} rows={22} spellCheck={false} value={json} onChange={(event) => { setJson(event.target.value); setError(''); }} /></Field>
        </>}
        </fieldset>
      </div>
      {error && <div role="alert" className={styles.formError}>{error}</div>}
      <footer className={styles.dialogFooter}><span className={styles.helpText}>{dirty ? t('ofs.dirtyNote') : t('ofs.savedNote')}</span>
        <div className={styles.actions}><button type="button" disabled={busy} className={styles.secondaryButton} onClick={requestClose}>{t('ofa.cancel')}</button>
          <button type="submit" disabled={busy} className={styles.primaryButton}><IconSave size={16} color="currentColor" />{busy ? t('ofs.saving') : t('ofs.save')}</button></div>
      </footer>
    </form>
  </OutfittingDialog>;
}
