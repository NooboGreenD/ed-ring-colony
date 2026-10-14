'use client';
import { cloneElement, useId, useState, type ReactElement, type ReactNode } from 'react';
import { IconPlus, IconRefresh, IconSave, IconTrash, IconWrench } from '@/components/Icons';
import { isRecord, validateCatalogValue } from '@/lib/outfitting/catalog';
import type { InternalSlot, OutfittingData, OutfittingShip, ShipProperties } from '@/lib/outfitting/types';
import { STANDARD_GROUPS } from '@/lib/outfitting/calc';
import type { CatalogEditorItem } from './OutfittingEditor';
import OutfittingDialog from './OutfittingDialog';
import styles from './OutfittingAdmin.module.css';

type Section = 'hardpoints' | 'internal';
type Tab = 'main' | 'specs' | 'slots' | 'json';
const TABS: Record<Tab, string> = { main: 'Основное', specs: 'Характеристики', slots: 'Слоты и комплектация', json: 'JSON' };
const SPECS: { key: keyof ShipProperties; label: string; optional?: boolean }[] = [
  { key: 'speed', label: 'Скорость, м/с' }, { key: 'boost', label: 'Форсаж, м/с' },
  { key: 'boostEnergy', label: 'Расход на форсаж, МДж' }, { key: 'boostInt', label: 'Интервал форсажа, с', optional: true },
  { key: 'baseShieldStrength', label: 'Базовый щит' }, { key: 'baseArmour', label: 'Базовая броня' },
  { key: 'heatCapacity', label: 'Теплоёмкость' }, { key: 'hardness', label: 'Твёрдость корпуса' },
  { key: 'hullMass', label: 'Масса корпуса, т' }, { key: 'masslock', label: 'Фактор блокировки FSD' },
  { key: 'pipSpeed', label: 'Заряд распределителя за секунду' }, { key: 'reserveFuelCapacity', label: 'Резерв топлива, т' },
  { key: 'minthrust', label: 'Минимальная тяга', optional: true },
  { key: 'pitch', label: 'Тангаж, °/с', optional: true }, { key: 'roll', label: 'Крен, °/с', optional: true },
  { key: 'yaw', label: 'Рысканье, °/с', optional: true },
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
      ? `Удалить слот ${label}? Он исчезнет из новых сборок, но останется на прежнем индексе для старых ссылок. Его можно восстановить в редакторе.`
      : `Удалить слот ${label}? Его параметры и заводской модуль будут потеряны.`;
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
      if (!isRecord(parsed)) throw new Error('JSON должен содержать объект корабля');
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
        throw new Error('Укажите характеристики, броню, слоты и заводскую комплектацию');
      }
      setDraft(value);
      setEligibleText(eligibleBuffers(value));
      if (next === 'json') setJson(JSON.stringify(value, null, 2));
      setTab(next); setError('');
    } catch { setError('Исправьте JSON слотов перед переключением вкладки'); }
  };
  const requestClose = () => {
    if (!busy && (!dirty || window.confirm('Есть несохранённые изменения. Закрыть редактор без сохранения?'))) onClose();
  };
  const submit = async () => {
    setError('');
    try {
      const value = prepare();
      const key = creating ? value.id : item.key;
      const validated = validateCatalogValue('ship', key, value, data) as OutfittingShip;
      setBusy(true);
      await onSave(key, validated);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить корабль'); }
    finally { setBusy(false); }
  };

  const slotList = (section: Section) => {
    const archivedCount = draft.slots[section].filter((slot) => typeof slot !== 'number' && slot.archived).length;
    return <div className={styles.slotSection} key={section}>
    <div className={styles.slotHeading}><h3>{section === 'hardpoints' ? 'Орудия и утилиты' : 'Внутренние отсеки'}</h3>
      <button type="button" className={styles.secondaryButton} disabled={draft.slots[section].length >= 64} onClick={() => addSlot(section)}><IconPlus size={14} color="currentColor" /> Добавить слот</button></div>
    <p className={styles.helpText}>Сохранённые слоты удаляются без смещения индексов: новые сборки их не используют, а старые сохраняют модули. Новые, ещё не сохранённые слоты удаляются окончательно. Размер 0 — вспомогательный слот (только для орудий/утилит).</p>
    {archivedCount > 0 && <button type="button" className={styles.quietButton} aria-expanded={showArchived[section]}
      onClick={() => setShowArchived((previous) => ({ ...previous, [section]: !previous[section] }))}>
      {showArchived[section] ? 'Скрыть удалённые слоты' : `Показать удалённые слоты (${archivedCount})`}
    </button>}
    {draft.slots[section].map((slot, index) => {
      const label = `${section === 'hardpoints' ? 'H' : 'I'}${index}`;
      const archived = typeof slot !== 'number' && slot.archived;
      if (archived) return showArchived[section] ? <div key={index} className={`${styles.slotRow} ${styles.deletedSlotRow}`}>
        <strong>{label}</strong><span className={styles.slotGroup}>Удалённый слот · размер {slot.class}{slot.name ? ` · ${slot.name}` : ''}</span>
        <button type="button" className={styles.restoreButton} aria-label={`Восстановить слот ${section} ${index}`} onClick={() => restoreSlot(section, index)}><IconRefresh size={14} color="currentColor" /> Восстановить</button>
        {(creating || index >= initial.slots[section].length) && <button type="button" className={styles.iconButton} aria-label={`Удалить слот ${section} ${index}`} title="Удалить окончательно" onClick={() => removeSlot(section, index)}><IconTrash size={15} color="currentColor" /></button>}
      </div> : null;
      const special = typeof slot === 'object';
      return <div key={index} className={styles.slotRow}>
        <strong>{section === 'hardpoints' ? 'H' : 'I'}{index}</strong>
        <label>Размер<select aria-label={`${section} ${index}: размер`} value={special ? slot.class : slot} onChange={(event) => setSlot(section, index, special ? { ...slot, class: Number(event.target.value) } : Number(event.target.value))}>
          {Array.from({ length: section === 'hardpoints' ? 5 : 8 }, (_, size) => <option key={size} value={section === 'hardpoints' ? size : size + 1}>{section === 'hardpoints' ? size : size + 1}</option>)}
        </select></label>
        <label>Заводской модуль<input aria-label={`${section} ${index}: заводской модуль`} value={String(draft.defaults[section][index] ?? '')} placeholder="ID модуля / 0" maxLength={64}
          onChange={(event) => setDefault(section, index, event.target.value)} /></label>
        <label className={styles.slotToggle}><input type="checkbox" checked={special} onChange={() => toggleSpecial(section, index)} /> Особый</label>
        <button type="button" className={styles.iconButton} aria-label={`Удалить слот ${section} ${index}`} title="Удалить слот" onClick={() => removeSlot(section, index)}><IconTrash size={15} color="currentColor" /></button>
        {special && <div className={styles.slotSpecial}>
          <Field label="Назначение слота"><input value={slot.name ?? ''} maxLength={80} placeholder="Military / Mining / Cargo" onChange={(event) => setSlot(section, index, { ...slot, name: event.target.value })} /></Field>
          <Field label="Допустимые группы (JSON)" hint={'Например {"hr":1,"mrp":1}; пусто — без ограничений. Группы должны существовать.'}>
            <textarea rows={3} className={styles.codeInput} spellCheck={false} value={eligibleText[`${section}:${index}`] ?? ''}
              onChange={(event) => { setEligibleText((previous) => ({ ...previous, [`${section}:${index}`]: event.target.value })); setError(''); }} />
          </Field>
        </div>}
      </div>;
    })}
  </div>;
  };

  return <OutfittingDialog title={`${creating ? 'Добавление' : 'Редактирование'} корабля`} eyebrow={creating ? 'Новый корпус' : item.key} onClose={requestClose} busy={busy}>
    <form className={styles.editorForm} onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
      <div className={styles.editorTabs} role="tablist" aria-label="Параметры корабля">
        {(Object.keys(TABS) as Tab[]).map((key) => <button type="button" role="tab" aria-selected={tab === key} aria-controls="ship-editor-panel" key={key}
          disabled={busy} className={tab === key ? styles.activeTab : styles.tabButton} onClick={() => changeTab(key)}>{TABS[key]}</button>)}
      </div>
      <div key={tab} className={styles.editorScroll} role="region" aria-label="Содержимое редактора корабля" tabIndex={0}>
        <fieldset disabled={busy} className={styles.editorBody} id="ship-editor-panel" role="tabpanel" aria-label={TABS[tab]}>
        {tab === 'main' && <>
          <div className={styles.note}><IconWrench size={16} color="currentColor" /><span>Кнопка добавления использует шаблон Sidewinder; можно также копировать подходящий корпус из списка. ID существующего корабля не меняется: он используется в ссылках и сохранённых сборках.</span></div>
          <div className={styles.formGrid}>
            <Field label="ID корабля" hint="Строчные латинские буквы, цифры, _ или -. После создания не меняется.">
              <input data-autofocus autoFocus required disabled={!creating} pattern="[a-z][a-z0-9_\-]{0,63}" maxLength={64} value={draft.id} onChange={(event) => update((ship) => { ship.id = event.target.value; })} />
            </Field>
            <Field label="Название корабля"><input required maxLength={160} value={draft.properties.name} onChange={(event) => setProperty('name', event.target.value)} /></Field>
            <Field label="Производитель"><input required maxLength={120} value={draft.properties.manufacturer} onChange={(event) => setProperty('manufacturer', event.target.value)} /></Field>
            <Field label="Размер корпуса"><select value={draft.properties.class} onChange={(event) => setProperty('class', Number(event.target.value))}>
              <option value={1}>1 — малый</option><option value={2}>2 — средний</option><option value={3}>3 — большой</option>
            </select></Field>
            <Field label="Стоимость корпуса, CR"><input type="number" min={0} step="any" required value={draft.properties.hullCost} onChange={(event) => setProperty('hullCost', event.target.value === '' ? undefined : Number(event.target.value))} /></Field>
            <Field label="Цена покупки, CR"><input type="number" min={0} step="any" required value={draft.retailCost} onChange={(event) => update((ship) => { ship.retailCost = Number(event.target.value); })} /></Field>
            <Field label="Экипаж"><input type="number" min={1} max={16} step={1} required value={draft.properties.crew} onChange={(event) => setProperty('crew', event.target.value === '' ? undefined : Number(event.target.value))} /></Field>
            <label className={styles.checkField}><input type="checkbox" checked={draft.properties.fighterHangars === true} onChange={(event) => setProperty('fighterHangars', event.target.checked)} /><span>Можно установить ангар истребителей</span></label>
            <label className={styles.checkField}><input type="checkbox" checked={draft.properties.luxuryCabins === true} onChange={(event) => setProperty('luxuryCabins', event.target.checked)} /><span>Доступны каюты люкс</span></label>
          </div>
          <p className={styles.helpText}>Броня: {draft.bulkheads.filter((entry) => !entry.archived).length} вариантов. После создания параметры и архивирование переборок доступны на вкладке «Броня» каталога.</p>
        </>}
        {tab === 'specs' && <><div className={styles.note}>Числовые характеристики используются калькулятором верфи. Масса корпуса и заряд распределителя должны быть больше нуля; остальные значения не могут быть отрицательными.</div>
          <div className={styles.formGrid}>{SPECS.map(({ key, label, optional }) => <Field key={key} label={label}>
            <input type="number" min={key === 'hullMass' || key === 'pipSpeed' ? '0.000001' : 0} step="any" required={!optional}
              value={typeof draft.properties[key] === 'number' ? String(draft.properties[key]) : ''} placeholder={optional ? 'Не задано' : undefined}
              onChange={(event) => setProperty(key, event.target.value === '' ? undefined : Number(event.target.value))} />
          </Field>)}</div>
        </>}
        {tab === 'slots' && <>
          <div className={styles.note}>Семь основных слотов обязательны. Орудийные и внутренние слоты можно добавить или удалить по отдельности; уже сохранённый слот архивируется, чтобы не сместить оборудование в старых сборках. Удалённые слоты можно восстановить. Заводская комплектация: ID модуля (в основных слотах можно класс+рейтинг, например 2E); 0 — пусто. Неизвестный ID оставит слот пустым.</div>
          <div className={styles.slotSection}><div className={styles.slotHeading}><h3>Основные модули</h3><span className={styles.helpText}>7 обязательных слотов</span></div>
            {draft.slots.standard.map((size, index) => <div className={styles.slotRow} key={index}>
              <strong>S{index}</strong><span className={styles.slotGroup}>{data.groups[STANDARD_GROUPS[index]]?.name ?? STANDARD_GROUPS[index]}</span>
              <label>Размер<select aria-label={`standard ${index}: размер`} value={size} onChange={(event) => update((ship) => { ship.slots.standard[index] = Number(event.target.value); })}>
                {Array.from({ length: 8 }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
              </select></label>
              <label>Заводской модуль<input aria-label={`standard ${index}: заводской модуль`} maxLength={64} value={String(draft.defaults.standard[index] ?? '')} onChange={(event) => setDefault('standard', index, event.target.value)} /></label>
            </div>)}
          </div>
          {slotList('hardpoints')}{slotList('internal')}
        </>}
        {tab === 'json' && <><div className={styles.note}>Полная запись корпуса и слотов. ID неизменен; броню существующего корабля редактируйте в отдельной вкладке «Броня» — прямые изменения этого массива не сохраняются.</div>
          <Field label="Данные корабля (JSON)" wide><textarea className={styles.codeInput} rows={22} spellCheck={false} value={json} onChange={(event) => { setJson(event.target.value); setError(''); }} /></Field>
        </>}
        </fieldset>
      </div>
      {error && <div role="alert" className={styles.formError}>{error}</div>}
      <footer className={styles.dialogFooter}><span className={styles.helpText}>{dirty ? 'Есть несохранённые изменения' : 'Изменения появятся в верфи после сохранения'}</span>
        <div className={styles.actions}><button type="button" disabled={busy} className={styles.secondaryButton} onClick={requestClose}>Отмена</button>
          <button type="submit" disabled={busy} className={styles.primaryButton}><IconSave size={16} color="currentColor" />{busy ? 'Сохранение…' : 'Сохранить'}</button></div>
      </footer>
    </form>
  </OutfittingDialog>;
}
