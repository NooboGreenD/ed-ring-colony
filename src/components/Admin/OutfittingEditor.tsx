'use client';
import { cloneElement, useId, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { IconPlus, IconSave, IconWrench } from '@/components/Icons';
import type { OutfittingData, PreEngineered } from '@/lib/outfitting/types';
import { CATALOG_CATEGORIES, isRecord, validateCatalogValue, type CatalogKind, type CatalogValue } from '@/lib/outfitting/catalog';
import { MODULE_SPECS, specFor, specName } from '@/lib/outfitting/specs';
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
const TAB_LABELS = { main: 'Основное', specs: 'Характеристики', factory: 'Заводская настройка', json: 'JSON' };
type EditorTab = keyof typeof TAB_LABELS;

export default function OutfittingEditor({ item, data, onClose, onSave }: {
  item: CatalogEditorItem;
  data: OutfittingData;
  onClose: () => void;
  onSave: (key: string, value: CatalogValue) => Promise<void>;
}) {
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
      .sort((a, b) => specName('ru', a).localeCompare(specName('ru', b), 'ru'));
  }, [data, draft, group, kind]);

  const prepare = (): Record<string, unknown> => {
    if (tab === 'json') {
      const parsed: unknown = JSON.parse(json);
      if (!isRecord(parsed)) throw new Error('JSON должен содержать объект записи');
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
    } catch { setError('Исправьте JSON перед переключением вкладки'); }
  };
  const requestClose = () => {
    if (!busy && (!dirty || window.confirm('Есть несохранённые изменения. Закрыть редактор без сохранения?'))) onClose();
  };
  const submit = async () => {
    setError('');
    try {
      const value = prepare();
      const key = creating ? (kind === 'group' ? owner : `${kind === 'module' ? value.grp : owner}:${value.id}`) : item.key;
      const validated = validateCatalogValue(kind, key, value, data);
      setBusy(true);
      await onSave(key, validated);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить запись'); }
    finally { setBusy(false); }
  };

  const numberInput = (key: string, required = false) => {
    const spec = specFor(key);
    const percent = spec?.percent ?? false;
    const value = typeof draft[key] === 'number' ? Number((Number(draft[key]) * (percent ? 100 : 1)).toFixed(8)) : '';
    return <Field key={key} label={`${specName('ru', key)}${percent ? ', %' : spec?.unit ? `, ${spec.unit}` : ''}`} hint={key}>
      <input type="number" step="any" min={['mass', 'power', 'cost', 'integrity', 'coins'].includes(key) ? 0 : undefined}
        required={required} value={value} placeholder="Не задано"
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
  const labels = kind === 'module' ? 'модуля' : kind === 'group' ? 'группы' : 'брони';

  return <OutfittingDialog title={`${creating ? 'Добавление' : 'Редактирование'} ${labels}`} eyebrow={creating ? 'Новая запись' : item.key} onClose={requestClose} busy={busy}>
    <form className={styles.editorForm} onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
      <div className={styles.editorTabs} role="tablist" aria-label="Параметры записи">
        {(Object.keys(TAB_LABELS) as EditorTab[]).filter((key) => kind === 'module' || key === 'main' || key === 'json' || (kind === 'bulkhead' && key === 'specs')).map((key) =>
          <button type="button" role="tab" aria-selected={tab === key} aria-controls="catalog-editor-panel" key={key}
            disabled={busy} className={tab === key ? styles.activeTab : styles.tabButton} onClick={() => changeTab(key)}>{TAB_LABELS[key]}</button>)}
      </div>
      <fieldset disabled={busy} className={styles.editorBody} id="catalog-editor-panel" role="tabpanel" aria-label={TAB_LABELS[tab]}>
        {tab === 'main' && <>
          <div className={styles.note}><IconWrench size={16} color="currentColor" /><span>Названия и параметры можно менять. Технические ID существующих записей сохраняются, чтобы не ломать ссылки на сборки.</span></div>
          <div className={styles.formGrid}>
            <Field label="Название" wide><input data-autofocus autoFocus required={creating || kind !== 'module'} maxLength={160} value={String(draft.name ?? '')}
              placeholder={kind === 'module' ? data.groups[group]?.name ?? 'Название модуля' : 'Название записи'} onChange={(event) => set('name', event.target.value)} /></Field>
            {kind === 'group' ? <>
              <Field label="Код группы" hint="Латинские буквы, цифры, _ или -. После создания не меняется."><input disabled={!creating} required pattern="[a-z][a-z0-9_\-]{0,31}" maxLength={32} value={owner} onChange={(event) => setOwner(event.target.value)} /></Field>
              <Field label="Категория" hint={!creating ? 'Встроенные и непустые группы нельзя переносить между категориями.' : undefined}>
                <select value={String(draft.category ?? 'internal')} disabled={!creating && (item.fromSource || data.groups[owner]?.category === 'core' || (data.modules[owner]?.length ?? 0) > 0)} onChange={(event) => set('category', event.target.value)}>
                  {Object.entries(CATALOG_CATEGORIES).filter(([key]) => !creating || key !== 'core').map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
              </Field>
              <Field label="Короткое название" hint="Необязательно"><input maxLength={40} value={String(draft.short ?? '')} onChange={(event) => set('short', event.target.value)} /></Field>
            </> : <>
              <Field label="ID записи" hint={creating ? 'Уникальный в группе / у корабля. Латинские буквы, цифры, _ или -.' : 'Постоянный идентификатор; для другого ID используйте копирование.'}>
                <input required pattern="[A-Za-z0-9_\-]{1,64}" maxLength={64} disabled={!creating} value={String(draft.id ?? '')} onChange={(event) => set('id', event.target.value)} />
              </Field>
              {kind === 'module' ? <Field label="Группа модулей"><select value={group} disabled={!creating} onChange={(event) => set('grp', event.target.value)}>
                {Object.entries(data.groups).map(([key, meta]) => <option key={key} value={key}>{meta.name} ({key})</option>)}
              </select></Field> : <Field label="Корабль"><select value={owner} disabled={!creating} onChange={(event) => setOwner(event.target.value)}>
                {Object.values(data.ships).sort((a, b) => a.properties.name.localeCompare(b.properties.name)).map((ship) => <option key={ship.id} value={ship.id}>{ship.properties.name}</option>)}
              </select></Field>}
              {kind === 'module' && <>
                <Field label="Класс"><input type="number" min={0} max={8} step={1} required value={String(draft.class ?? '')} onChange={(event) => set('class', event.target.value === '' ? undefined : Number(event.target.value))} /></Field>
                <Field label="Рейтинг"><select value={String(draft.rating ?? 'A')} onChange={(event) => set('rating', event.target.value)}>{'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((rating) => <option key={rating}>{rating}</option>)}</select></Field>
                <Field label="Крепление"><select value={String(draft.mount ?? '')} onChange={(event) => set('mount', event.target.value)}>
                  <option value="">Не применяется</option><option value="F">F — фиксированное</option><option value="T">T — наводящееся</option><option value="G">G — турель</option>
                </select></Field>
              </>}
              {numberInput('mass', kind === 'bulkhead')}{numberInput('cost', kind === 'bulkhead')}
              {kind === 'module' && <>{numberInput('power')}{numberInput('integrity')}
                <Field label="Powerplay" hint="Название фракции / лидера, необязательно"><input maxLength={120} value={String(draft.pp ?? '')} onChange={(event) => set('pp', event.target.value)} /></Field>
                <label className={styles.checkField}><input type="checkbox" checked={draft.merc === true} onChange={(event) => set('merc', event.target.checked || undefined)} /><span>Продаётся за Merc Coin</span></label>
                {draft.merc === true && numberInput('coins')}
                <Field label="Примечание" wide><textarea rows={3} maxLength={4000} value={String(draft.info ?? '')} onChange={(event) => set('info', event.target.value)} /></Field>
              </>}
            </>}
          </div>
        </>}
        {tab === 'specs' && <>
          <div className={styles.note}>Показаны все числовые параметры группы. Пустое поле не задаёт значение, 0 — задаёт ноль. Сопротивления и бонусы в форме указаны в процентах; в JSON — в долях.</div>
          <div className={styles.formGrid}>{numericFields.map((key) => numberInput(key, kind === 'bulkhead' && key !== 'causres'))}</div>
          {kind === 'module' && <div className={styles.addParameter}>
            <label className={styles.field}><span>Добавить параметр</span><input list="catalog-numeric-fields" placeholder="Код параметра, например damage" value={newField} onChange={(event) => setNewField(event.target.value)} /></label>
            <datalist id="catalog-numeric-fields">{MODULE_SPECS.filter((spec) => !(spec.key in draft)).map((spec) => <option key={spec.key} value={spec.key}>{specName('ru', spec.key)}</option>)}</datalist>
            <button type="button" className={styles.secondaryButton} disabled={!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(newField) || newField in draft || ['id', 'grp', 'rating', 'name', 'mount', 'preEngineered', 'constructor', 'prototype'].includes(newField)}
              onClick={() => { set(newField, 0); setNewField(''); }}><IconPlus size={14} color="currentColor" /> Добавить</button>
          </div>}
          <div className={styles.formGrid}>
            {kind === 'module' && (data.groups[group]?.category === 'hardpoint' || !!draft.damagedist) && objectField('damagedist', 'Распределение урона (JSON)', 'Например {"T": 1} — термический; K — кинетический, E — взрывной, A — AX.')}
            {Object.keys(buffers).filter((key) => key !== 'damagedist' && key !== 'preEngineered.features').map((key) => objectField(key, `${key} (JSON)`, key === 'requirements' ? 'Требования: числовые значения или переключатели, например {"horizons": true}.' : 'Все дополнительные поля сохраняются без потери данных.'))}
          </div>
          <p className={styles.helpText}>Строковые и нестандартные параметры также доступны во вкладке JSON.</p>
        </>}
        {tab === 'factory' && <>
          <label className={styles.checkField}><input type="checkbox" checked={!!factory} onChange={(event) => set('preEngineered', event.target.checked ? { grade: 5, reengineerable: false, gradeChangeable: false, canApplyExperimental: true } : undefined)} /><span>Предварительно модифицированный модуль (Pre-engineered)</span></label>
          {factory ? <>
            <div className={styles.formGrid}>
              <Field label="Заводской уровень"><input type="number" min={1} max={5} step={1} value={factory.grade ?? 5} onChange={(event) => setFactory('grade', Number(event.target.value))} /></Field>
              <Field label="Чертежи" hint="Ctrl / ⌘ + клик для нескольких чертежей"><select multiple size={5} value={factory.blueprints ?? []} onChange={(event) => setFactory('blueprints', Array.from(event.target.selectedOptions, (option) => option.value))}>
                {availableBlueprints.map((key) => <option key={key} value={key}>{key}</option>)}
              </select></Field>
              <Field label="Заводские экспериментальные эффекты"><select multiple size={5} value={factory.experimentalEffects ?? []} onChange={(event) => setFactory('experimentalEffects', Array.from(event.target.selectedOptions, (option) => option.value))}>
                {availableSpecials.map((key) => <option key={key} value={key}>{data.specials[key]?.name ?? key}</option>)}
              </select></Field>
              {([['reengineerable', 'Можно менять чертёж'], ['gradeChangeable', 'Можно менять уровень'], ['canApplyExperimental', 'Можно применять экспериментальный эффект'], ['approx', 'Приблизительные характеристики']] as const).map(([key, label]) =>
                <label key={key} className={styles.checkField}><input type="checkbox" checked={factory[key] === true} onChange={(event) => setFactory(key, event.target.checked)} /><span>{label}</span></label>)}
              <Field label="Условия получения"><input value={factory.availability ?? ''} maxLength={4000} onChange={(event) => setFactory('availability', event.target.value)} /></Field>
              <Field label="Код рецепта"><input value={factory.recipe ?? ''} maxLength={4000} onChange={(event) => setFactory('recipe', event.target.value)} /></Field>
              <Field label="Описание заводской настройки" wide><textarea value={factory.description ?? ''} maxLength={4000} rows={3} onChange={(event) => setFactory('description', event.target.value)} /></Field>
              {objectField('preEngineered.features', 'Дополнительные заводские модификаторы (JSON)', 'Поле → доля изменения. Например {"mass": -0.2} — масса −20%.')}
            </div>
          </> : <p className={styles.helpText}>Включите настройку, чтобы задать чертежи, заводские модификаторы и ограничения инженерии.</p>}
        </>}
        {tab === 'json' && <>
          <div className={styles.note}>Полная запись без потери дополнительных полей. Проценты хранятся в долях (0.25 = 25%). При сохранении проверяются типы и постоянные ID.</div>
          <Field label="Данные записи (JSON)" wide><textarea className={styles.codeInput} rows={22} spellCheck={false} value={json} onChange={(event) => { setJson(event.target.value); setError(''); }} /></Field>
        </>}
      </fieldset>
      {error && <div className={styles.formError} role="alert">{error}</div>}
      <footer className={styles.dialogFooter}>
        <span className={styles.helpText}>{dirty ? 'Есть несохранённые изменения' : 'Изменения появятся в верфи после сохранения'}</span>
        <div className={styles.actions}><button type="button" disabled={busy} className={styles.secondaryButton} onClick={requestClose}>Отмена</button>
          <button type="submit" disabled={busy} className={styles.primaryButton}><IconSave size={16} color="currentColor" />{busy ? 'Сохранение…' : 'Сохранить'}</button></div>
      </footer>
    </form>
  </OutfittingDialog>;
}
