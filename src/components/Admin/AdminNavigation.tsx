'use client';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  IconAnchor, IconCoins, IconDatabase, IconGear, IconGlobe, IconHeadphones, IconHomeSystem,
  IconJournal, IconLock, IconMessage, IconPackage, IconRoute, IconSatellite, IconUsers,
} from '@/components/Icons';
import styles from './AdminShell.module.css';

export const ADMIN_TABS = ['content', 'manage', 'route', 'forum', 'news', 'hubs', 'sync', 'comments', 'support', 'billing', 'monitor', 'auth', 'galaxy', 'backup', 'helper', 'outfitting'] as const;
export type AdminTab = typeof ADMIN_TABS[number];
export const ADMIN_ONLY_TABS: AdminTab[] = ['outfitting', 'monitor', 'auth', 'galaxy', 'backup', 'helper'];
export function isAdminTab(tab: string | null): tab is AdminTab {
  return !!tab && (ADMIN_TABS as readonly string[]).includes(tab);
}

/** Two-level navigation replaces the unstructured wall of sixteen buttons. */
export default function AdminNavigation({ tab, role, onSelect }: { tab: AdminTab; role: string; onSelect: (tab: AdminTab) => void }) {
  const { t } = useI18n();
  const groups = [
    { id: 'site', label: 'Контент сайта', icon: IconJournal, items: [
      { id: 'content', label: t('admin.content'), icon: IconJournal },
      { id: 'news', label: t('admin.news'), icon: IconGlobe },
    ] },
    { id: 'community', label: 'Сообщество', icon: IconUsers, items: [
      { id: 'manage', label: t('admin.manage'), icon: IconUsers },
      { id: 'forum', label: t('admin.forum'), icon: IconMessage },
      { id: 'comments', label: t('admin.comments'), icon: IconMessage },
      { id: 'support', label: t('admin.support'), icon: IconHeadphones },
    ] },
    { id: 'game', label: 'Игровые данные', icon: IconAnchor, items: [
      { id: 'outfitting', label: 'Верфь', icon: IconAnchor },
      { id: 'hubs', label: t('admin.hubs'), icon: IconHomeSystem },
      { id: 'route', label: t('admin.route'), icon: IconRoute },
      { id: 'sync', label: 'RavenColonial', icon: IconSatellite },
      { id: 'galaxy', label: 'Каталог систем', icon: IconGlobe },
    ] },
    { id: 'system', label: 'Система и сервисы', icon: IconGear, items: [
      { id: 'billing', label: t('admin.billing'), icon: IconCoins },
      { id: 'monitor', label: 'Мониторинг', icon: IconSatellite },
      { id: 'backup', label: 'Бэкапы', icon: IconDatabase },
      { id: 'auth', label: 'Авторизация', icon: IconLock },
      { id: 'helper', label: 'Обновления Helper', icon: IconPackage },
    ] },
  ].map((group) => ({ ...group, items: group.items.filter((item) => role === 'admin' || !ADMIN_ONLY_TABS.includes(item.id as AdminTab)) }));
  const currentGroup = groups.find((group) => group.items.some((item) => item.id === tab)) ?? groups[0];
  return <nav className={styles.navigation} aria-label="Навигация админ-панели">
    <div className={styles.groupNavigation} aria-label="Группы разделов">
      {groups.filter((group) => group.items.length > 0).map((group) => <button type="button" key={group.id} className={group.id === currentGroup.id ? styles.activeGroup : styles.groupButton}
        aria-pressed={group.id === currentGroup.id} onClick={() => onSelect(group.items[0].id as AdminTab)}><group.icon size={17} color="currentColor" /><span>{group.label}</span><small>{group.items.length}</small></button>)}
    </div>
    <div className={styles.tabNavigation} aria-label="Разделы выбранной группы">
      {currentGroup.items.map((item) => <button type="button" key={item.id} className={item.id === tab ? styles.activeTab : styles.tabButton}
        aria-current={item.id === tab ? 'page' : undefined} onClick={() => onSelect(item.id as AdminTab)}><item.icon size={15} color="currentColor" />{item.label}</button>)}
    </div>
  </nav>;
}
