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
      { label: 'Полное наименование', value: 'Иваровский Роман Олегович' },
      { label: 'ИНН', value: '971306804602' },
            {
        label: 'Юридический адрес',
        value: '180016, г. Псков, Рижский пр-кт, д. 45, офис 1',
      },
    ],
  },
  {
    title: 'Банковские реквизиты',
    items: [
      { label: 'Расчётный счёт', value: '40820810800001055886' },
      { label: 'Банк', value: 'АО «ТБанк»' },
      { label: 'БИК', value: '044525974' },
      { label: 'Корреспондентский счёт', value: '30101810145250000974' },
    ],
  },
  {
    title: 'Контакты',
    items: [
      { label: 'Email', value: 'info@edringcolony.ru' },
      { label: 'Телефон', value: '+7 (996) 090-75-30' },
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
