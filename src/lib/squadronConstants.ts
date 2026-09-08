// ============================================================
// Константы для эскадрилий Elite Dangerous
// ============================================================

/** Державы (Powers) Elite Dangerous */
export const ED_POWERS = [
  { value: "", label: "— Не выбрано —" },
  { value: "Aisling Duval", label: "Aisling Duval" },
  { value: "Archon Delaine", label: "Archon Delaine" },
  { value: "Arissa Lavigny-Duval", label: "Arissa Lavigny-Duval" },
  { value: "Denton Patreus", label: "Denton Patreus" },
  { value: "Edmund Mahon", label: "Edmund Mahon" },
  { value: "Felicia Winters", label: "Felicia Winters" },
  { value: "Jerome Archer", label: "Jerome Archer" },
  { value: "Li Yong-Rui", label: "Li Yong-Rui" },
  { value: "Nakato Kaine", label: "Nakato Kaine" },
  { value: "Pranav Antal", label: "Pranav Antal" },
  { value: "Yuri Grom", label: "Yuri Grom" },
  { value: "Zemina Torval", label: "Zemina Torval" },
] as const;

/** Виды принадлежности (Allegiance) Elite Dangerous */
export const ED_ALLEGIANCES = [
  { value: "Independent", label: "Независимая" },
  { value: "Alliance", label: "Альянс" },
  { value: "Empire", label: "Империя" },
  { value: "Federation", label: "Федерация" },
] as const;

/** Языки */
export const LANGUAGES = [
  { value: "Russian", label: "Русский" },
  { value: "English", label: "English" },
  { value: "German", label: "Deutsch" },
  { value: "French", label: "Français" },
  { value: "Spanish", label: "Español" },
  { value: "Portuguese", label: "Português" },
  { value: "Italian", label: "Italiano" },
  { value: "Polish", label: "Polski" },
  { value: "Chinese", label: "中文" },
  { value: "Japanese", label: "日本語" },
  { value: "Korean", label: "한국어" },
  { value: "Turkish", label: "Türkçe" },
  { value: "Arabic", label: "العربية" },
  { value: "Other", label: "Другой" },
] as const;

/** Часовые пояса (UTC смещения) */
export const TIMEZONES = [
  { value: "UTC-12:00", label: "UTC−12:00" },
  { value: "UTC-11:00", label: "UTC−11:00" },
  { value: "UTC-10:00", label: "UTC−10:00" },
  { value: "UTC-09:30", label: "UTC−09:30" },
  { value: "UTC-09:00", label: "UTC−09:00" },
  { value: "UTC-08:00", label: "UTC−08:00" },
  { value: "UTC-07:00", label: "UTC−07:00" },
  { value: "UTC-06:00", label: "UTC−06:00" },
  { value: "UTC-05:00", label: "UTC−05:00" },
  { value: "UTC-04:00", label: "UTC−04:00" },
  { value: "UTC-03:30", label: "UTC−03:30" },
  { value: "UTC-03:00", label: "UTC−03:00" },
  { value: "UTC-02:00", label: "UTC−02:00" },
  { value: "UTC-01:00", label: "UTC−01:00" },
  { value: "UTC+00:00", label: "UTC±00:00" },
  { value: "UTC+01:00", label: "UTC+01:00" },
  { value: "UTC+02:00", label: "UTC+02:00" },
  { value: "UTC+03:00", label: "UTC+03:00" },
  { value: "UTC+03:30", label: "UTC+03:30" },
  { value: "UTC+04:00", label: "UTC+04:00" },
  { value: "UTC+04:30", label: "UTC+04:30" },
  { value: "UTC+05:00", label: "UTC+05:00" },
  { value: "UTC+05:30", label: "UTC+05:30" },
  { value: "UTC+05:45", label: "UTC+05:45" },
  { value: "UTC+06:00", label: "UTC+06:00" },
  { value: "UTC+06:30", label: "UTC+06:30" },
  { value: "UTC+07:00", label: "UTC+07:00" },
  { value: "UTC+08:00", label: "UTC+08:00" },
  { value: "UTC+08:45", label: "UTC+08:45" },
  { value: "UTC+09:00", label: "UTC+09:00" },
  { value: "UTC+09:30", label: "UTC+09:30" },
  { value: "UTC+10:00", label: "UTC+10:00" },
  { value: "UTC+10:30", label: "UTC+10:30" },
  { value: "UTC+11:00", label: "UTC+11:00" },
  { value: "UTC+12:00", label: "UTC+12:00" },
  { value: "UTC+12:45", label: "UTC+12:45" },
  { value: "UTC+13:00", label: "UTC+13:00" },
  { value: "UTC+14:00", label: "UTC+14:00" },
] as const;

/** Типы активности эскадрильи */
export const ACTIVITY_TYPES = [
  { value: "Mixed", label: "Смешанная" },
  { value: "Combat", label: "Боевые операции" },
  { value: "Exploration", label: "Исследования" },
  { value: "Trading", label: "Торговля" },
  { value: "Mining", label: "Добыча" },
  { value: "Bounty Hunting", label: "Охота за головами" },
  { value: "PVP", label: "PVP" },
  { value: "Roleplay", label: "Ролевая игра" },
  { value: "Colonia", label: "Колонизация" },
  { value: "Powerplay", label: "Powerplay" },
] as const;

/** Лимит участников в эскадрилье Elite Dangerous */
export const SQUADRON_MEMBER_LIMIT = 600;

/** Минимальный интервал между сменами названия (дней) */
export const NAME_CHANGE_COOLDOWN_DAYS = 30;
