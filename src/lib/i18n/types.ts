export type Locale = 'ru' | 'en' | 'de' | 'it' | 'ko' | 'zh' | 'ja';

/**
 * Ключи навигации и базового каркаса сайта.
 *
 * Полный словарь живёт в `translations.ts`; здесь перечислены ключи, которые
 * используются напрямую в меню и шапке, чтобы опечатка в имени ключа ловилась
 * компилятором, а не вылезала английским текстом в интерфейсе.
 */
export type TranslationKey =
  | 'nav.home'
  | 'nav.map'
  | 'nav.news'
  | 'nav.galnet'
  | 'nav.forum'
  | 'nav.wiki'
  | 'nav.leaderboard'
  | 'nav.systems'
  | 'nav.cmdrs'
  | 'nav.squadrons'
  | 'nav.projects'
  | 'nav.architect'
  | 'nav.outfitting'
  | 'nav.engineers'
  | 'nav.atlas'
  | 'nav.sectors'
  | 'nav.support'
  | 'nav.shop'
  | 'nav.account'
  | 'nav.group.navigation'
  | 'nav.group.community'
  | 'nav.group.tools'
  | 'nav.group.help'
  // Секции меню пользователя (топбар). Персональные разделы живут там, а не в
  // боковой навигации: см. комментарий в Sidebar.tsx.
  | 'account.group.profile'
  | 'account.group.services'
  | 'account.group.staff'
  | 'account.myBuilds'
  | 'nav.filter'
  | 'nav.empty'
  | 'nav.menu'
  | 'nav.closeMenu'
  | 'nav.collapseSection'
  | 'lang.ru'
  | 'lang.en'
  | 'lang.de'
  | 'lang.it'
  | 'lang.ko'
  | 'lang.zh'
  | 'lang.ja';
