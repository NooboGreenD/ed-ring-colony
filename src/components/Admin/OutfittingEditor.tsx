'use client';
import { cloneElement, useId, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { IconPlus, IconSave, IconWrench } from '@/components/Icons';
import type { OutfittingData, PreEngineered } from '@/lib/outfitting/types';
import { CATALOG_CATEGORIES, CATALOG_MOUNTS, isRecord, validateCatalogValue, type CatalogKind, type CatalogValue } from '@/lib/outfitting/catalog';
import { MODULE_SPECS, specFor, specName } from '@/lib/outfitting/specs';
import { useI18n } from '@/lib/i18n/I18nContext';
import OutfittingDialog from './OutfittingDialog';
import styles from './OutfittingAdmin.module.css';

export interface CatalogEditorItem {
  kind: CatalogKind;
  key: string;
  value: CatalogValue;
  mode: 'create' | 'update';
  fromSource?: boolean;
}

function Field({ label, hint, children, wide = false }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  const id = useId();
  return <div className={`${styles.field} ${wide ? styles.wideField : ''}`}>
    <label htmlFor={id}>{label}</label>
    {cloneElement(children as ReactElement<{ id?: string; 'aria-describedby'?: string }>, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })}
    {hint && <small id={`${id}-hint`}>{hint}</small>}
  </div>;
}

function initialBuffers(value: Record<string, unknown>): Record<string, string> {
  const entries = Object.entries(value).filter(([key, entry]) => key !== 'preEngineered' && isRecord(entry));
  const buffers = Object.fromEntries(entries.map(([key, entry]) => [key, JSON.stringify(entry, null, 2)]));
  const factory = value.preEngineered as PreEngineered | undefined;
  if (factory?.features) buffers['preEngineered.features'] = JSON.stringify(factory.features, null, 2);
  return buffers;
}

const GENERIC = ['class', 'mass', 'cost', 'power', 'integrity'];
const TAB_LABELS = { main: 'oed.tab.main', specs: 'oed.tab.specs', factory: 'oed.tab.factory', json: 'oed.tab.json' };
type EditorTab = keyof typeof TAB_LABELS;

export default function OutfittingEditor({ item, data, onClose, onSave }: {
  item: CatalogEditorItem;
  data: OutfittingData;
  onClose: () => void;
  onSave: (key: string, value: CatalogValue) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const initial = item.value as unknown as Record<string, unknown>;
  const [draft, setDraft] = useState<Record<string, unknown>>(() => structuredClone(initial));
  const [owner, setOwner] = useState(item.key.split(':')[0]);
  const [tab, setTab] = useState<EditorTab>('main');
  const [json, setJson] = useState(JSON.stringify(initial, null, 2));
  const [buffers, setBuffers] = useState(() => initialBuffers(initial));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newField, setNewField] = useState('');
  const kind = item.kind;
  const creating = item.mode === 'create';
  const group = String(draft.grp ?? owner);
  const factory = draft.preEngineered as PreEngineered | undefined;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || owner !== item.key.split(':')[0]
    || JSON.stringify(buffers) !== JSON.stringify(initialBuffers(initial))
    || (tab === 'json' && json !== JSON.stringify(initial, null, 2));

  const set = (key: string, value: unknown) => {
    setDraft((previous) => {
      const next = { ...previous };
      if (value === '' || value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
    setError('');
  };
  const setFactory = (key: keyof PreEngineered, value: unknown) => {
    const next = { ...factory };
    if (value === '') delete next[key];
    else Object.assign(next, { [key]: value });
    set('preEngineered', next);
  };

  const numericFields = useMemo(() => {
    const values = kind === 'bulkhead'
      ? ['hullboost', 'kinres', 'thermres', 'explres', 'causres']
      : (data.modules[group] ?? []).flatMap((module) => Object.keys(module).filter((key) => typeof module[key] === 'number'));
    const keys = new Set([...values, ...Object.keys(draft).filter((key) => typeof draft[key] === 'number')]);
    return [...keys].filter((key) => !GENERIC.includes(key))
      .sort((a, b) => specName(locale, a).localeCompare(specName(locale, b), locale));
  }, [data, draft, group, kind, locale]);

  const prepare = (): Record<string, unknown> => {
    if (tab === 'json') {
      const parsed: unknown = JSON.parse(json);
      if (!isRecord(parsed)) throw new Error(t('oed.jsonObjectError'));
      return parsed;
    }
    const value = structuredClone(draft);
    for (const [key, raw] of Object.entries(buffers)) {
      if (key === 'preEngineered.features') {
        if (!value.preEngineered) continue;
        const config = value.preEngineered as Record<string, unknown>;
        if (!raw.trim()) delete config.features;
        else config.features = JSON.parse(raw);
      } else if (!raw.trim()) delete value[key];
      else value[key] = JSON.parse(raw);
    }
    return value;
  };

  const changeTab = (next: EditorTab) => {
    try {
      const value = prepare();
      setDraft(value);
      setBuffers(initialBuffers(value));
      if (next === 'json') setJson(JSON.stringify(value, null, 2));
      setTab(next); setError('');
    } catch { setError(t('oed.jsonBeforeTab')); }
  };
  const requestClose = () => {
    if (!busy && (!dirty || window.confirm(t('oed.confirmClose')))) onClose();
  };
  const submit = async () => {
    setError('');
    try {
      const value = prepare();
      const key = creating ? (kind === 'group' ? owner : `${kind === 'module' ? value.grp : owner}:${value.id}`) : item.key;
      const validated = validateCatalogValue(kind, key, value, data);
      setBusy(true);
      await onSave(key, validated);
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('oed.saveFailed')); }
    finally { setBusy(false); }
  };

  const numberInput = (key: string, required = false) => {
    const spec = specFor(key);
    const percent = spec?.percent ?? false;
    const value = typeof draft[key] === 'number' ? Number((Number(draft[key]) * (percent ? 100 : 1)).toFixed(8)) : '';
    return <Field key={key} label={`${specName(locale, key)}${percent ? ', %' : spec?.unit ? `, ${spec.unit}` : ''}`} hint={key}>
      <input type="number" step="any" min={['mass', 'power', 'cost', 'integrity', 'coins'].includes(key) ? 0 : undefined}
        required={required} value={value} placeholder={t('oed.notSet')}
        onChange={(event) => set(key, event.target.value === '' ? undefined : Number(event.target.value) / (percent ? 100 : 1))} />
    </Field>;
  };
  const objectField = (key: string, label: string, hint: string) => <Field key={key} label={label} hint={hint} wide>
    <textarea className={styles.codeInput} spellCheck={false} rows={4} value={buffers[key] ?? ''} placeholder="{}"
      onChange={(event) => { setBuffers((previous) => ({ ...previous, [key]: event.target.value })); setError(''); }} />
  </Field>;
  const availableBlueprints = Array.from(new Set([
    ...Object.keys(data.moduleBlueprints[group]?.blueprints ?? {}), ...(factory?.blueprints ?? []),
  ]));
  const availableSpecials = Array.from(new Set([
    ...(data.moduleBlueprints[group]?.specials ?? []), ...(factory?.experimentalEffects ?? []),
  ]));
  const kindLabel = kind === 'module' ? 'Module' : kind === 'group' ? 'Group' : 'Bulkhead';

  return <OutfittingDialog title={t(`oed.${creating ? 'create' : 'edit'}${kindLabel}`)} eyebrow={creating ? t('oed.newRecord') : item.key} onClose={requestClose} busy={busy}>
    <form className={styles.editorForm} onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
      <div className={styles.editorTabs} role="tablist" aria-label={t('oed.recordParams')}>
        {(Object.keys(TAB_LABELS) as EditorTab[]).filter((key) => kind === 'module' || key === 'main' || key === 'json' || (kind === 'bulkhead' && key === 'specs')).map((key) =>
          <button type="button" role="tab" aria-selected={tab === key} aria-controls="catalog-editor-panel" key={key}
            disabled={busy} className={tab === key ? styles.activeTab : styles.tabButton} onClick={() => changeTab(key)}>{t(TAB_LABELS[key])}</button>)}
      </div>
      <div key={tab} className={styles.editorScroll} role="region" aria-label={t('oed.editorContent')} tabIndex={0}>
        <fieldset disabled={busy} className={styles.editorBody} id="catalog-editor-panel" role="tabpanel" aria-label={t(TAB_LABELS[tab])}>
        {tab === 'main' && <>
          <div className={styles.note}><IconWrench size={16} color="currentColor" /><span>{t('oed.noteIds')}</span></div>
          <div className={styles.formGrid}>
            <Field label={t('oed.name')} wide><input data-autofocus autoFocus required={creating || kind !== 'module'} maxLength={160} value={String(draft.name ?? '')}
              placeholder={kind === 'module' ? data.groups[group]?.name ?? t('oed.moduleNamePlaceholder') : t('oed.recordNamePlaceholder')} onChange={(event) => set('name', event.target.value)} /></Field>
            {kind === 'group' ? <>
              <Field label={t('oed.groupCode')} hint={t('oed.groupCodeHint')}><input disabled={!creating} required pattern="[a-z][a-z0-9_\-]{0,31}" maxLength={32} value={owner} onChange={(event) => setOwner(event.target.value)} /></Field>
              <Field label={t('oed.category')} hint={!creating ? t('oed.categoryHint') : undefined}>
                <select value={String(draft.category ?? 'internal')} disabled={!creating && (item.fromSource || data.groups[owner]?.category === 'core' || (data.modules[owner]?.length ?? 0) > 0)} onChange={(event) => set('category', event.target.value)}>
                  {Object.entries(CATALOG_CATEGORIES).filter(([key]) => !creating || key !== 'core').map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
              </Field>
              <Field label={t('oed.shortName')} hint={t('oed.shortNameHint')}><input maxLength={40} value={String(draft.short ?? '')} onChange={(event) => set('short', event.target.value)} /></Field>
            </> : <>
              <Field label={t('oed.recordId')} hint={creating ? t('oed.recordIdHintCreate') : t('oed.recordIdHintEdit')}>
                <input required pattern="[A-Za-z0-9_\-]{1,64}" maxLength={64} disabled={!creating} value={String(draft.id ?? '')} onChange={(event) => set('id', event.target.value)} />
              </Field>
              {kind === 'module' ? <Field label={t('oed.moduleGroup')}><select value={group} disabled={!creating} onChange={(event) => set('grp', event.target.value)}>
                {Object.entries(data.groups).map(([key, meta]) => <option key={key} value={key}>{meta.name} ({key})</option>)}
              </select></Field> : <Field label={t('oed.ship')}><select value={owner} disabled={!creating} onChange={(event) => setOwner(event.target.value)}>
                {Object.values(data.ships).sort((a, b) => a.properties.name.localeCompare(b.properties.name, locale)).map((ship) => <option key={ship.id} value={ship.id}>{ship.properties.name}{ship.archived ? t('oed.archivedSuffix') : ''}</option>)}
              </select></Field>}
              {kind === 'module' && <>
                <Field label={t('oed.class')}><input type="number" min={0} max={8} step={1} required value={String(draft.class ?? '')} onChange={(event) => set('class', event.target.value === '' ? undefined : Number(event.target.value))} /></Field>
                <Field label={t('oed.rating')}><select value={String(draft.rating ?? 'A')} onChange={(event) => set('rating', event.target.value)}>{'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((rating) => <option key={rating}>{rating}</option>)}</select></Field>
                <Field label={t('oed.mount')}><select value={String(draft.mount ?? '')} onChange={(event) => set('mount', event.target.value)}>
                  <option value="">{t('oed.mountNone')}</option>
                  {Object.entries(CATALOG_MOUNTS).map(([key, mount]) => <option key={key} value={key}>{key} — {mount.title}</option>)}
                </select></Field>
              </>}
              {numberInput('mass', kind === 'bulkhead')}{numberInput('cost', kind === 'bulkhead')}
              {kind === 'module' && <>{numberInput('power')}{numberInput('integrity')}
                <Field label={t('oed.powerplay')} hint={t('oed.powerplayHint')}><input maxLength={120} value={String(draft.pp ?? '')} onChange={(event) => set('pp', event.target.value)} /></Field>
                <label className={styles.checkField}><input type="checkbox" checked={draft.merc === true} onChange={(event) => set('merc', event.target.checked || undefined)} /><span>{t('oed.mercCoin')}</span></label>
                {draft.merc === true && numberInput('coins')}
                <Field label={t('oed.info')} wide><textarea rows={3} maxLength={4000} value={String(draft.info ?? '')} onChange={(event) => set('info', event.target.value)} /></Field>
              </>}
            </>}
          </div>
        </>}
        {tab === 'specs' && <>
          <div className={styles.note}>{t('oed.specsNote')}</div>
          <div className={styles.formGrid}>{numericFields.map((key) => numberInput(key, kind === 'bulkhead' && key !== 'causres'))}</div>
          {kind === 'module' && <div className={styles.addParameter}>
            <label className={styles.field}><span>{t('oed.addParameter')}</span><input list="catalog-numeric-fields" placeholder={t('oed.addParameterPlaceholder')} value={newField} onChange={(event) => setNewField(event.target.value)} /></label>
            <datalist id="catalog-numeric-fields">{MODULE_SPECS.filter((spec) => !(spec.key in draft)).map((spec) => <option key={spec.key} value={spec.key}>{specName(locale, spec.key)}</option>)}</datalist>
            <button type="button" className={styles.secondaryButton} disabled={!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(newField) || newField in draft || ['id', 'grp', 'rating', 'name', 'mount', 'preEngineered', 'constructor', 'prototype'].includes(newField)}
              onClick={() => { set(newField, 0); setNewField(''); }}><IconPlus size={14} color="currentColor" /> {t('oed.add')}</button>
          </div>}
          <div className={styles.formGrid}>
            {kind === 'module' && (data.groups[group]?.category === 'hardpoint' || !!draft.damagedist) && objectField('damagedist', t('oed.damagedist'), t('oed.damagedistHint'))}
            {Object.keys(buffers).filter((key) => key !== 'damagedist' && key !== 'preEngineered.features').map((key) => objectField(key, `${key} (JSON)`, key === 'requirements' ? t('oed.requirementsHint') : t('oed.objectFieldHint')))}
          </div>
          <p className={styles.helpText}>{t('oed.helpTextSpecs')}</p>
        </>}
        {tab === 'factory' && <>
          <label className={styles.checkField}><input type="checkbox" checked={!!factory} onChange={(event) => set('preEngineered', event.target.checked ? { grade: 5, reengineerable: false, gradeChangeable: false, canApplyExperimental: true } : undefined)} /><span>{t('oed.preEngineered')}</span></label>
          {factory ? <>
            <div className={styles.formGrid}>
              <Field label={t('oed.factoryGrade')}><input type="number" min={1} max={5} step={1} value={factory.grade ?? 5} onChange={(event) => setFactory('grade', Number(event.target.value))} /></Field>
              <Field label={t('oed.blueprints')} hint={t('oed.blueprintsHint')}><select multiple size={5} value={factory.blueprints ?? []} onChange={(event) => setFactory('blueprints', Array.from(event.target.selectedOptions, (option) => option.value))}>
                {availableBlueprints.map((key) => <option key={key} value={key}>{key}</option>)}
              </select></Field>
              <Field label={t('oed.factoryEffects')}><select multiple size={5} value={factory.experimentalEffects ?? []} onChange={(event) => setFactory('experimentalEffects', Array.from(event.target.selectedOptions, (option) => option.value))}>
                {availableSpecials.map((key) => <option key={key} value={key}>{data.specials[key]?.name ?? key}</option>)}
              </select></Field>
              {([['reengineerable', t('oed.reengineerable')], ['gradeChangeable', t('oed.gradeChangeable')], ['canApplyExperimental', t('oed.canApplyExperimental')], ['approx', t('oed.approx')]] as const).map(([key, label]) =>
                <label key={key} className={styles.checkField}><input type="checkbox" checked={factory[key] === true} onChange={(event) => setFactory(key, event.target.checked)} /><span>{label}</span></label>)}
              <Field label={t('oed.availability')}><input value={factory.availability ?? ''} maxLength={4000} onChange={(event) => setFactory('availability', event.target.value)} /></Field>
              <Field label={t('oed.recipe')}><input value={factory.recipe ?? ''} maxLength={4000} onChange={(event) => setFactory('recipe', event.target.value)} /></Field>
              <Field label={t('oed.factoryDescription')} wide><textarea value={factory.description ?? ''} maxLength={4000} rows={3} onChange={(event) => setFactory('description', event.target.value)} /></Field>
              {objectField('preEngineered.features', t('oed.features'), t('oed.featuresHint'))}
            </div>
          </> : <p className={styles.helpText}>{t('oed.factoryHint')}</p>}
        </>}
        {tab === 'json' && <>
          <div className={styles.note}>{t('oed.jsonNote')}</div>
          <Field label={t('oed.jsonData')} wide><textarea className={styles.codeInput} rows={22} spellCheck={false} value={json} onChange={(event) => { setJson(event.target.value); setError(''); }} /></Field>
        </>}
        </fieldset>
      </div>
      {error && <div className={styles.formError} role="alert">{error}</div>}
      <footer className={styles.dialogFooter}>
        <span className={styles.helpText}>{dirty ? t('oed.unsaved') : t('oed.savedHint')}</span>
        <div className={styles.actions}><button type="button" disabled={busy} className={styles.secondaryButton} onClick={requestClose}>{t('ofa.cancel')}</button>
          <button type="submit" disabled={busy} className={styles.primaryButton}><IconSave size={16} color="currentColor" />{busy ? t('oed.saving') : t('oed.save')}</button></div>
      </footer>
    </form>
  </OutfittingDialog>;
}
