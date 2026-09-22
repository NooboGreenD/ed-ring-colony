// ============================================================
// РЕКВИЗИТЫ ОРГАНИЗАЦИИ — ЗАГЛУШКА
// Замените значения ниже на реальные реквизиты.
// Страница доступна только по прямой ссылке /details,
// не отображается в меню и закрыта от индексации.
// ============================================================

export interface RequisiteItem {
  label: string;
  value: string;
  hint?: string;
}

export interface RequisiteGroup {
  title: string;
  items: RequisiteItem[];
}

export const REQUISITES: RequisiteGroup[] = [
  {
    title: 'Организация',
    items: [
      { label: 'Полное наименование', value: 'ИП Иванов Иван Иванович' },
      { label: 'ИНН', value: '000000000000', hint: '12 цифр для ИП, 10 — для ООО' },
      { label: 'ОГРН/ОГРНИП', value: '000000000000000' },
      { label: 'КПП', value: '000000000', hint: 'только для ООО' },
      {
        label: 'Юридический адрес',
        value: '123456, г. Москва, ул. Примерная, д. 1, офис 1',
      },
    ],
  },
  {
    title: 'Банковские реквизиты',
    items: [
      { label: 'Расчётный счёт', value: '40802810000000000000' },
      { label: 'Банк', value: 'АО «ТБанк»' },
      { label: 'БИК', value: '044525974' },
      { label: 'Корреспондентский счёт', value: '30101810145250000974' },
    ],
  },
  {
    title: 'Контакты',
    items: [
      { label: 'Email', value: 'info@example.com' },
      { label: 'Телефон', value: '+7 (000) 000-00-00' },
    ],
  },
];

// Одной строкой — для кнопки «Скопировать всё»
export function requisitesAsPlainText(): string {
  return REQUISITES.map(
    (group) =>
      `${group.title}\n` +
      group.items.map((item) => `${item.label}: ${item.value}`).join('\n'),
  ).join('\n\n');
}
