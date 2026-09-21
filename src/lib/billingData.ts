import fs from 'fs';
import path from 'path';
import type {
  BillingPlan,
  UserSubscription,
  ShopItem,
  UserInventoryItem,
  EquippedCosmetics,
  BillingTransaction,
  UserBalance,
  ProjectBillingStats,
  ChartDataPoint,
  PilotGrowthPoint,
  TierDistribution,
  CategorySalesStat,
  FunnelStep,
} from '@/types/billing';
import { supabaseAdmin } from './supabaseAdmin';

const DATA_FILE = path.join(process.cwd(), 'data', 'billing_store.json');

// Initial pre-configured plans
export const INITIAL_PLANS: BillingPlan[] = [
  {
    id: 'pioneer',
    name: 'Пионер Кольца',
    name_en: 'Ring Pioneer',
    description: 'Базовый премиальный статус для исследователей и строителей колонии.',
    description_en: 'Standard premium tier for Ring explorers and builders.',
    price_rub: 290,
    price_credits: 2500,
    period_days: 30,
    badge_label: 'PIONEER',
    color: '#3498db',
    is_active: true,
    is_popular: false,
    display_order: 1,
    perks: [
      'Особый позывной и тактический префикс [PIO]',
      'Приоритетная синхронизация логов CAPI и журнала',
      'Скидка 25% на косметические улучшения в магазине',
      'Эксклюзивный знак отличия Пионера в профиле',
      'Доступ к расширенной телеметрии экспедиции',
    ],
    created_at: '2026-01-15T00:00:00Z',
  },
  {
    id: 'elite',
    name: 'Элита Колонии',
    name_en: 'Colonia Elite',
    description: 'Расширенный статус с кастомными темами интерфейса и голографическими рамками.',
    description_en: 'Advanced tier with custom HUD interface themes and holographic avatar frames.',
    price_rub: 590,
    price_credits: 5000,
    period_days: 30,
    badge_label: 'ELITE',
    color: '#e67e22',
    is_active: true,
    is_popular: true,
    display_order: 2,
    perks: [
      'Все привилегии уровня «Пионер Кольца»',
      'Голографическая неоновая рамка аватара на выбор',
      'Кастомные HUD-темы оформления интерфейса сайта',
      'Скидка 50% на все товары Премиум-магазина',
      'Приоритет в голосовых каналах эскадрилий',
      'Нагрудный знак ветерана Элиты Колонии',
      'Увеличенный лимит избранных систем в Атласе до 100',
    ],
    created_at: '2026-01-15T00:00:00Z',
  },
  {
    id: 'admiral',
    name: 'Флотоводец VIP',
    name_en: 'Fleet Admiral VIP',
    description: 'Высший ранг покровителя проекта с полным доступом ко всем украшениям и VIP-каналам.',
    description_en: 'Highest benefactor tier with full access to all cosmetics and VIP priority.',
    price_rub: 1190,
    price_credits: 10000,
    period_days: 30,
    badge_label: 'VIP ADMIRAL',
    color: '#9b59b6',
    is_active: true,
    is_popular: false,
    display_order: 3,
    perks: [
      'Полный безлимитный доступ ко всем модулям платформы',
      'Анимированные эффекты хроматического свечения ника',
      'Все легендарные голографические рамки аватаров',
      'Скидка 75% в магазине косметики + доступ к VIP-эксклюзивам',
      'VIP-статус в технической поддержке с ускоренным ответом',
      'Именная золотая запись в реестре Основателей Кольца',
      'Личный золотой штандарт Флотоводца с орлиными крыльями',
      'Возможность закреплять сообщения в общем чате',
    ],
    created_at: '2026-01-15T00:00:00Z',
  },
];

// Initial pre-configured shop cosmetics
export const INITIAL_SHOP_ITEMS: ShopItem[] = [
  // ── Frames ──
  {
    id: 'frame-singularity',
    category: 'frame',
    title: 'Квантовая Сингулярность',
    title_en: 'Quantum Singularity',
    description: 'Вращающееся гравитационное кольцо аккреционного диска с фиолетовым свечением искривленного пространства.',
    description_en: 'Rotating gravitational accretion disk with violet curved space glow.',
    price_credits: 3500,
    price_rub: 450,
    rarity: 'legendary',
    requires_subscription: null,
    subscriber_discount_pct: 35,
    preview_data: {
      color: '#a855f7',
      accentColor: '#3b82f6',
      glowColor: 'rgba(168, 85, 247, 0.65)',
      frameStyle: 'singularity',
      borderWidth: 3,
    },
    is_active: true,
    is_featured: true,
    sales_count: 84,
    created_at: '2026-02-01T00:00:00Z',
  },
  {
    id: 'frame-vanguard',
    category: 'frame',
    title: 'Авангард Колонии',
    title_en: 'Colonia Vanguard',
    description: 'Тактическая бронированная рамка с угловыми оптическими визирами и янтарной телеметрией.',
    description_en: 'Tactical armored frame with corner optical brackets and amber telemetry.',
    price_credits: 2200,
    price_rub: 290,
    rarity: 'epic',
    requires_subscription: null,
    subscriber_discount_pct: 25,
    preview_data: {
      color: '#e67e22',
      accentColor: '#f39c12',
      glowColor: 'rgba(230, 126, 34, 0.55)',
      frameStyle: 'vanguard',
      borderWidth: 2,
    },
    is_active: true,
    is_featured: false,
    sales_count: 142,
    created_at: '2026-02-05T00:00:00Z',
  },
  {
    id: 'frame-subzero',
    category: 'frame',
    title: 'Ледяной Импульс',
    title_en: 'Sub-Zero Pulse',
    description: 'Криогенный гексагональный силовой щит с бегущей волной неонового циана.',
    description_en: 'Cryogenic hexagonal power shield with running neon cyan wave.',
    price_credits: 1500,
    price_rub: 190,
    rarity: 'rare',
    requires_subscription: null,
    subscriber_discount_pct: 20,
    preview_data: {
      color: '#06b6d4',
      accentColor: '#38bdf8',
      glowColor: 'rgba(6, 182, 212, 0.6)',
      frameStyle: 'subzero',
      borderWidth: 2,
    },
    is_active: true,
    is_featured: false,
    sales_count: 98,
    created_at: '2026-02-10T00:00:00Z',
  },
  {
    id: 'frame-solar',
    category: 'frame',
    title: 'Вспышка Сверхновой',
    title_en: 'Solar Flare',
    description: 'Плазменная корона звезды O-класса с пульсирующими выбросами солнечного протуберанца.',
    description_en: 'O-class star plasma corona with pulsing solar prominences.',
    price_credits: 2400,
    price_rub: 320,
    rarity: 'epic',
    requires_subscription: 'elite',
    subscriber_discount_pct: 50,
    preview_data: {
      color: '#f97316',
      accentColor: '#eab308',
      glowColor: 'rgba(249, 115, 22, 0.7)',
      frameStyle: 'solar',
      borderWidth: 3,
    },
    is_active: true,
    is_featured: true,
    sales_count: 73,
    created_at: '2026-02-15T00:00:00Z',
  },
  {
    id: 'frame-stealth',
    category: 'frame',
    title: 'Фантом Бездны',
    title_en: 'Stealth Phantom',
    description: 'Композитное углеродное покрытие с матовым черным профилем и приглушенным рубиновым сканером.',
    description_en: 'Composite carbon coating with matte black profile and ruby scanner.',
    price_credits: 1600,
    price_rub: 210,
    rarity: 'rare',
    requires_subscription: null,
    subscriber_discount_pct: 20,
    preview_data: {
      color: '#ef4444',
      accentColor: '#1e2022',
      glowColor: 'rgba(239, 68, 68, 0.45)',
      frameStyle: 'stealth',
      borderWidth: 2,
    },
    is_active: true,
    is_featured: false,
    sales_count: 61,
    created_at: '2026-02-20T00:00:00Z',
  },

  // ── Badges ──
  {
    id: 'badge-founder',
    category: 'badge',
    title: 'Орден Основателя Кольца',
    title_en: 'Ring Founder Crest',
    description: 'Золотой двуглавый звездный орел с пульсаром в центре. Знак высшего признания заслуг перед экспедицией.',
    description_en: 'Golden double-headed star eagle with central pulsar. Symbol of highest honor.',
    price_credits: 2800,
    price_rub: 390,
    rarity: 'legendary',
    requires_subscription: 'admiral',
    subscriber_discount_pct: 50,
    preview_data: {
      color: '#fbbf24',
      icon: 'crown',
      badgeSvg: 'founder_wings',
    },
    is_active: true,
    is_featured: true,
    sales_count: 53,
    created_at: '2026-02-01T00:00:00Z',
  },
  {
    id: 'badge-explorer',
    category: 'badge',
    title: 'Звездный Первопроходец',
    title_en: 'Deep Space Pioneer',
    description: 'Навигационный астролябический компас с указанием на координаты центра Галактики.',
    description_en: 'Astrolabe navigation compass pointing towards Sagittarius A*.',
    price_credits: 1200,
    price_rub: 150,
    rarity: 'rare',
    requires_subscription: null,
    subscriber_discount_pct: 15,
    preview_data: {
      color: '#38bdf8',
      icon: 'compass',
      badgeSvg: 'explorer_compass',
    },
    is_active: true,
    is_featured: false,
    sales_count: 114,
    created_at: '2026-02-08T00:00:00Z',
  },
  {
    id: 'badge-titan',
    category: 'badge',
    title: 'Покоритель Титанов',
    title_en: 'Titan Slayer',
    description: 'Биолюминесцентная кислотно-изумрудная метка победы над Таргоидскими материнскими кораблями.',
    description_en: 'Bioluminescent emerald mark of victory against Thargoid Titan motherships.',
    price_credits: 2000,
    price_rub: 260,
    rarity: 'epic',
    requires_subscription: null,
    subscriber_discount_pct: 25,
    preview_data: {
      color: '#10b981',
      icon: 'sword',
      badgeSvg: 'titan_breaker',
    },
    is_active: true,
    is_featured: false,
    sales_count: 88,
    created_at: '2026-02-12T00:00:00Z',
  },
  {
    id: 'badge-carrier',
    category: 'badge',
    title: 'Владелец Флагмана',
    title_en: 'Fleet Carrier Sovereign',
    description: 'Тяжелый алмазный адмиралтейский шеврон командующего флотом мегакораблей.',
    description_en: 'Heavy diamond admiralty chevron of a megaship carrier fleet commander.',
    price_credits: 2100,
    price_rub: 280,
    rarity: 'epic',
    requires_subscription: 'pioneer',
    subscriber_discount_pct: 30,
    preview_data: {
      color: '#60a5fa',
      icon: 'anchor',
      badgeSvg: 'carrier_diamond',
    },
    is_active: true,
    is_featured: false,
    sales_count: 76,
    created_at: '2026-02-18T00:00:00Z',
  },
  {
    id: 'badge-mining',
    category: 'badge',
    title: 'Мастер Глубинного Бурения',
    title_en: 'Core Mining Supreme',
    description: 'Сияющий кристалл редких минералов кольца, расколотый сейсмическим зарядом.',
    description_en: 'Gleaming ring core mineral crystal cracked by seismic charges.',
    price_credits: 800,
    price_rub: 99,
    rarity: 'common',
    requires_subscription: null,
    subscriber_discount_pct: 10,
    preview_data: {
      color: '#a3e635',
      icon: 'diamond',
      badgeSvg: 'mining_drill',
    },
    is_active: true,
    is_featured: false,
    sales_count: 147,
    created_at: '2026-02-22T00:00:00Z',
  },

  // ── HUD Skins ──
  {
    id: 'skin-amber',
    category: 'skin',
    title: 'Колониальный Закат',
    title_en: 'Colonia Sunset',
    description: 'Теплая янтарно-медная палитра приборов, создающая атмосферу уюта далеких колониальных станций.',
    description_en: 'Warm amber-copper HUD palette reminiscent of deep Colonia space outposts.',
    price_credits: 900,
    price_rub: 120,
    rarity: 'common',
    requires_subscription: null,
    subscriber_discount_pct: 20,
    preview_data: {
      color: '#f59e0b',
      accentColor: '#d97706',
      hudSkinClass: 'skin-colonia-amber',
    },
    is_active: true,
    is_featured: false,
    sales_count: 189,
    created_at: '2026-02-01T00:00:00Z',
  },
  {
    id: 'skin-cyber',
    category: 'skin',
    title: 'Киберпанк 3309',
    title_en: 'Cyberpunk 3309',
    description: 'Высококонтрастный футуристичный стиль с неоновым цианом и пульсирующей неоновой маджентой.',
    description_en: 'High-contrast futuristic HUD skin with cyber cyan and pulsing neon magenta.',
    price_credits: 2500,
    price_rub: 330,
    rarity: 'epic',
    requires_subscription: 'elite',
    subscriber_discount_pct: 50,
    preview_data: {
      color: '#ec4899',
      accentColor: '#06b6d4',
      hudSkinClass: 'skin-cyberpunk-3309',
    },
    is_active: true,
    is_featured: true,
    sales_count: 102,
    created_at: '2026-02-05T00:00:00Z',
  },
  {
    id: 'skin-void',
    category: 'skin',
    title: 'Холодный Космос',
    title_en: 'Void Navigator',
    description: 'Глубокий флотский ультрамарин с серебряной подсветкой для снижения нагрузки на зрение в дальних перелетах.',
    description_en: 'Deep naval ultramarine with silver telemetry for low-fatigue long-range jumping.',
    price_credits: 1400,
    price_rub: 180,
    rarity: 'rare',
    requires_subscription: null,
    subscriber_discount_pct: 20,
    preview_data: {
      color: '#3b82f6',
      accentColor: '#93c5fd',
      hudSkinClass: 'skin-void-navigator',
    },
    is_active: true,
    is_featured: false,
    sales_count: 85,
    created_at: '2026-02-14T00:00:00Z',
  },
  {
    id: 'skin-imperial',
    category: 'skin',
    title: 'Имперское Золото',
    title_en: 'Imperial Sovereign Gold',
    description: 'Аристократическая тема в стилистике кораблей Гутмайя — чистый обсидиан и полированное имперское золото.',
    description_en: 'Aristocratic Gutamaya-inspired theme with pure obsidian and polished imperial gold.',
    price_credits: 3200,
    price_rub: 420,
    rarity: 'legendary',
    requires_subscription: 'admiral',
    subscriber_discount_pct: 60,
    preview_data: {
      color: '#eab308',
      accentColor: '#fef08a',
      hudSkinClass: 'skin-imperial-gold',
    },
    is_active: true,
    is_featured: true,
    sales_count: 67,
    created_at: '2026-02-20T00:00:00Z',
  },
  {
    id: 'skin-emerald',
    category: 'skin',
    title: 'Изумрудный Стан',
    title_en: 'Emerald Outpost',
    description: 'Милитаристский изумрудный интерфейс орбитальной обороны с повышенной четкостью шрифтов.',
    description_en: 'Tactical military emerald orbital defence HUD with crisp high-clarity typography.',
    price_credits: 1500,
    price_rub: 190,
    rarity: 'rare',
    requires_subscription: null,
    subscriber_discount_pct: 20,
    preview_data: {
      color: '#10b981',
      accentColor: '#34d399',
      hudSkinClass: 'skin-emerald-outpost',
    },
    is_active: true,
    is_featured: false,
    sales_count: 79,
    created_at: '2026-02-24T00:00:00Z',
  },

  // ── Callsign Glow ──
  {
    id: 'glow-hyperspace',
    category: 'glow',
    title: 'Призматический Гиперпрыжок',
    title_en: 'Hyperdrive Prismatic Shimmer',
    description: 'Хроматический спектральный перелив имени пилота с эффектом искривления червоточины Witchspace.',
    description_en: 'Chromatic spectral shimmer effect mimicking Witchspace corridor entry.',
    price_credits: 2900,
    price_rub: 380,
    rarity: 'legendary',
    requires_subscription: 'elite',
    subscriber_discount_pct: 50,
    preview_data: {
      color: '#8b5cf6',
      accentColor: '#ec4899',
      gradient: 'linear-gradient(90deg, #ec4899, #8b5cf6, #06b6d4, #ec4899)',
      glowColor: '0 0 12px rgba(139, 92, 246, 0.75)',
    },
    is_active: true,
    is_featured: true,
    sales_count: 91,
    created_at: '2026-02-03T00:00:00Z',
  },
  {
    id: 'glow-neutron',
    category: 'glow',
    title: 'Свечение Нейтронной Струи',
    title_en: 'Neutron Jet Beam',
    description: 'Ослепительно яркий конический луч нейтронной звезды с белым электромагнитным ядром.',
    description_en: 'Dazzling conical relativistic jet glow with bright electromagnetic core.',
    price_credits: 2100,
    price_rub: 270,
    rarity: 'epic',
    requires_subscription: null,
    subscriber_discount_pct: 25,
    preview_data: {
      color: '#38bdf8',
      accentColor: '#ffffff',
      gradient: 'linear-gradient(90deg, #38bdf8, #e0f2fe, #38bdf8)',
      glowColor: '0 0 14px rgba(56, 189, 248, 0.85)',
    },
    is_active: true,
    is_featured: false,
    sales_count: 83,
    created_at: '2026-02-11T00:00:00Z',
  },
  {
    id: 'glow-solar',
    category: 'glow',
    title: 'Солнечная Радиация',
    title_en: 'Solar Radiation Halo',
    description: 'Мягкое теплое золотисто-янтарное гало с переливом цвета расплавленного золота.',
    description_en: 'Soft warm golden-amber halo radiating molten gold shades.',
    price_credits: 1300,
    price_rub: 160,
    rarity: 'rare',
    requires_subscription: null,
    subscriber_discount_pct: 20,
    preview_data: {
      color: '#f59e0b',
      accentColor: '#fbbf24',
      gradient: 'linear-gradient(90deg, #f59e0b, #fef08a, #f59e0b)',
      glowColor: '0 0 10px rgba(245, 158, 11, 0.65)',
    },
    is_active: true,
    is_featured: false,
    sales_count: 94,
    created_at: '2026-02-16T00:00:00Z',
  },
  {
    id: 'glow-voidpulse',
    category: 'glow',
    title: 'Тень Сингулярности',
    title_en: 'Void Singularity Shadow',
    description: 'Таинственная пульсирующая фиолетово-черная аура с эффектом гравитационного линзирования текста.',
    description_en: 'Mysterious pulsing violet-black aura with gravitational text lensing.',
    price_credits: 1400,
    price_rub: 170,
    rarity: 'rare',
    requires_subscription: null,
    subscriber_discount_pct: 20,
    preview_data: {
      color: '#9333ea',
      accentColor: '#c084fc',
      gradient: 'linear-gradient(90deg, #9333ea, #e9d5ff, #9333ea)',
      glowColor: '0 0 12px rgba(147, 51, 234, 0.7)',
    },
    is_active: true,
    is_featured: false,
    sales_count: 71,
    created_at: '2026-02-21T00:00:00Z',
  },

  // ── Titles ──
  {
    id: 'title-architect',
    category: 'title',
    title: 'Архитектор Нового Рубежа',
    title_en: 'Architect of the New Frontier',
    description: 'Высшее почетное звание для лидеров колонизационных проектов и строителей мегаструктур.',
    description_en: 'Honorary title for colonization project leaders and megastructure builders.',
    price_credits: 1800,
    price_rub: 240,
    rarity: 'epic',
    requires_subscription: 'pioneer',
    subscriber_discount_pct: 30,
    preview_data: {
      color: '#f97316',
      subTitle: 'ARCHITECT OF THE NEW FRONTIER',
    },
    is_active: true,
    is_featured: false,
    sales_count: 65,
    created_at: '2026-02-04T00:00:00Z',
  },
  {
    id: 'title-trailblazer',
    category: 'title',
    title: 'Первопроходец Бездны',
    title_en: 'Void Trailblazer',
    description: 'Легендарный титул командиров, преодолевших тысячи световых лет в неизвестные сектора кольца.',
    description_en: 'Legendary title for commanders navigating untamed deep space sectors.',
    price_credits: 2600,
    price_rub: 350,
    rarity: 'legendary',
    requires_subscription: 'elite',
    subscriber_discount_pct: 40,
    preview_data: {
      color: '#a855f7',
      subTitle: 'VOID TRAILBLAZER',
    },
    is_active: true,
    is_featured: true,
    sales_count: 82,
    created_at: '2026-02-09T00:00:00Z',
  },
  {
    id: 'title-jaques',
    category: 'title',
    title: 'Легенда Жак-Стейшн',
    title_en: 'Jaques Station Legend',
    description: 'Звание ветерана исторического маршрута из Пузыря в Колонию.',
    description_en: 'Title bestowed upon veterans of the historic Sol-to-Colonia highway.',
    price_credits: 1200,
    price_rub: 150,
    rarity: 'rare',
    requires_subscription: null,
    subscriber_discount_pct: 20,
    preview_data: {
      color: '#38bdf8',
      subTitle: 'JAQUES STATION LEGEND',
    },
    is_active: true,
    is_featured: false,
    sales_count: 99,
    created_at: '2026-02-15T00:00:00Z',
  },
  {
    id: 'title-marshal',
    category: 'title',
    title: 'Маршал Звездного Пути',
    title_en: 'Starway Marshal',
    description: 'Почетный титул организаторов и защитников колонизационных конвоев.',
    description_en: 'Honorary title for organizers and protectors of colonial supply convoys.',
    price_credits: 3000,
    price_rub: 400,
    rarity: 'legendary',
    requires_subscription: 'admiral',
    subscriber_discount_pct: 50,
    preview_data: {
      color: '#eab308',
      subTitle: 'STARWAY MARSHAL',
    },
    is_active: true,
    is_featured: false,
    sales_count: 48,
    created_at: '2026-02-23T00:00:00Z',
  },
];

interface BillingStoreSchema {
  plans: BillingPlan[];
  subscriptions: UserSubscription[];
  shopItems: ShopItem[];
  inventory: UserInventoryItem[];
  equipped: Record<string, EquippedCosmetics>;
  transactions: BillingTransaction[];
  balances: Record<string, UserBalance>;
}

function generateInitialStore(): BillingStoreSchema {
  const plans = INITIAL_PLANS;
  const shopItems = INITIAL_SHOP_ITEMS;

  // Realistic sample subscribers
  const samplePilots = [
    { name: 'CMDR Coriolus', role: 'admin', tier: 'admiral', daysLeft: 28, spent: 4820 },
    { name: 'CMDR Elena Vance', role: 'user', tier: 'elite', daysLeft: 19, spent: 2360 },
    { name: 'CMDR Starfarer_99', role: 'user', tier: 'pioneer', daysLeft: 12, spent: 1190 },
    { name: 'CMDR NovaVanguard', role: 'moderator', tier: 'admiral', daysLeft: 25, spent: 3950 },
    { name: 'CMDR Alexey Gromov', role: 'user', tier: 'elite', daysLeft: 8, spent: 1770 },
    { name: 'CMDR HorizonSeeker', role: 'user', tier: 'pioneer', daysLeft: 14, spent: 870 },
    { name: 'CMDR Dmitry_K', role: 'user', tier: 'elite', daysLeft: 22, spent: 2950 },
    { name: 'CMDR BlackHoleDrifter', role: 'user', tier: 'admiral', daysLeft: 30, spent: 5400 },
    { name: 'CMDR Viktor_Steele', role: 'user', tier: 'pioneer', daysLeft: 4, spent: 580 },
    { name: 'CMDR Sarah_Connor', role: 'user', tier: 'elite', daysLeft: 16, spent: 1770 },
    { name: 'CMDR Hyperion_01', role: 'user', tier: 'elite', daysLeft: 27, spent: 2360 },
    { name: 'CMDR VoidWalker_RU', role: 'user', tier: 'pioneer', daysLeft: 21, spent: 870 },
  ];

  const now = new Date('2026-09-21T05:00:00Z');
  const subscriptions: UserSubscription[] = samplePilots.map((p, idx) => {
    const plan = plans.find((pl) => pl.id === p.tier)!;
    const expiresAt = new Date(now.getTime() + p.daysLeft * 24 * 3600 * 1000);
    const startedAt = new Date(expiresAt.getTime() - plan.period_days * 24 * 3600 * 1000);
    return {
      id: `sub-${idx + 101}`,
      user_id: `user-sim-${idx + 1}`,
      cmdr_name: p.name,
      plan_id: p.tier,
      status: 'active',
      started_at: startedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      auto_renew: true,
      payment_method: idx % 3 === 0 ? 'sbp' : 'card',
      notes: idx === 0 ? 'Главный администратор колонии' : 'Автоматическое продление',
      created_at: startedAt.toISOString(),
      updated_at: startedAt.toISOString(),
      plan,
    };
  });

  // Seeded transactions history over past 6 months
  const transactions: BillingTransaction[] = [];
  let txCounter = 9480;

  // Add subscription transactions for sample pilots
  samplePilots.forEach((p, idx) => {
    const plan = plans.find((pl) => pl.id === p.tier)!;
    txCounter++;
    transactions.push({
      id: `TX-2026-${txCounter}`,
      user_id: `user-sim-${idx + 1}`,
      cmdr_name: p.name,
      type: 'subscription',
      item_or_plan_id: plan.id,
      item_title: `Подписка «${plan.name}» (30 дн)`,
      amount_rub: plan.price_rub,
      amount_credits: 0,
      payment_method: idx % 3 === 0 ? 'sbp' : 'card',
      status: 'completed',
      created_at: new Date(now.getTime() - (30 - p.daysLeft) * 24 * 3600 * 1000).toISOString(),
    });
  });

  // Generate historical purchases and credit top-ups
  const sampleCosmetics = shopItems.slice(0, 12);
  for (let i = 1; i <= 65; i++) {
    txCounter++;
    const daysAgo = Math.floor(Math.pow(Math.random(), 1.6) * 120);
    const txDate = new Date(now.getTime() - daysAgo * 24 * 3600 * 1000 - Math.random() * 86400000);
    const pilot = samplePilots[i % samplePilots.length];
    const isCreditTopup = i % 5 === 0;

    if (isCreditTopup) {
      const topupRub = [300, 600, 1200, 2500][i % 4];
      const topupCredits = [2500, 5500, 12000, 26000][i % 4];
      transactions.push({
        id: `TX-2026-${txCounter}`,
        user_id: `user-sim-${(i % samplePilots.length) + 1}`,
        cmdr_name: pilot.name,
        type: 'credit_topup',
        item_or_plan_id: `pack-${topupCredits}`,
        item_title: `Пакет очков снабжения (+${topupCredits} Кредитов)`,
        amount_rub: topupRub,
        amount_credits: topupCredits,
        payment_method: 'sbp',
        status: 'completed',
        created_at: txDate.toISOString(),
      });
    } else {
      const item = sampleCosmetics[i % sampleCosmetics.length];
      const useCredits = i % 2 === 0;
      transactions.push({
        id: `TX-2026-${txCounter}`,
        user_id: `user-sim-${(i % samplePilots.length) + 1}`,
        cmdr_name: pilot.name,
        type: 'shop_purchase',
        item_or_plan_id: item.id,
        item_title: item.title,
        amount_rub: useCredits ? 0 : item.price_rub,
        amount_credits: useCredits ? item.price_credits : 0,
        payment_method: useCredits ? 'credits' : 'card',
        status: i === 12 ? 'refunded' : 'completed',
        created_at: txDate.toISOString(),
      });
    }
  }

  // Sort transactions by date descending
  transactions.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  // Inventory & Equipped
  const inventory: UserInventoryItem[] = [
    {
      id: 'inv-1',
      user_id: 'user-sim-1',
      item_id: 'frame-singularity',
      purchased_at: '2026-08-10T12:00:00Z',
      price_paid_credits: 3500,
      price_paid_rub: 0,
      is_equipped: true,
      item: shopItems.find((s) => s.id === 'frame-singularity'),
    },
    {
      id: 'inv-2',
      user_id: 'user-sim-1',
      item_id: 'badge-founder',
      purchased_at: '2026-08-12T14:30:00Z',
      price_paid_credits: 2800,
      price_paid_rub: 0,
      is_equipped: true,
      item: shopItems.find((s) => s.id === 'badge-founder'),
    },
    {
      id: 'inv-3',
      user_id: 'user-sim-1',
      item_id: 'glow-hyperspace',
      purchased_at: '2026-08-15T18:00:00Z',
      price_paid_credits: 2900,
      price_paid_rub: 0,
      is_equipped: true,
      item: shopItems.find((s) => s.id === 'glow-hyperspace'),
    },
    {
      id: 'inv-4',
      user_id: 'user-sim-1',
      item_id: 'title-architect',
      purchased_at: '2026-08-18T10:00:00Z',
      price_paid_credits: 1800,
      price_paid_rub: 0,
      is_equipped: true,
      item: shopItems.find((s) => s.id === 'title-architect'),
    },
  ];

  const equipped: Record<string, EquippedCosmetics> = {
    'user-sim-1': {
      user_id: 'user-sim-1',
      frame_id: 'frame-singularity',
      badge_id: 'badge-founder',
      skin_id: 'skin-cyber',
      glow_id: 'glow-hyperspace',
      title_id: 'title-architect',
      updated_at: '2026-09-01T00:00:00Z',
    },
  };

  const balances: Record<string, UserBalance> = {
    'user-sim-1': {
      user_id: 'user-sim-1',
      credits: 4500,
      total_spent_rub: 4820,
      total_spent_credits: 11000,
      updated_at: now.toISOString(),
    },
  };

  return {
    plans,
    subscriptions,
    shopItems,
    inventory,
    equipped,
    transactions,
    balances,
  };
}

class BillingRepository {
  private store: BillingStoreSchema;

  constructor() {
    this.store = this.loadStore();
  }

  private loadStore(): BillingStoreSchema {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        // Ensure all top-level keys exist
        return {
          plans: parsed.plans || INITIAL_PLANS,
          subscriptions: parsed.subscriptions || [],
          shopItems: parsed.shopItems || INITIAL_SHOP_ITEMS,
          inventory: parsed.inventory || [],
          equipped: parsed.equipped || {},
          transactions: parsed.transactions || [],
          balances: parsed.balances || {},
        };
      }
    } catch (e) {
      console.warn('[BillingRepository] Error loading data file, re-seeding:', e);
    }

    const initial = generateInitialStore();
    this.saveStore(initial);
    return initial;
  }

  private saveStore(store: BillingStoreSchema): void {
    try {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf-8');
    } catch (e) {
      console.error('[BillingRepository] Error saving data file:', e);
    }
  }

  // ── Plans ──
  getPlans(): BillingPlan[] {
    return [...this.store.plans].sort((a, b) => a.display_order - b.display_order);
  }

  getPlanById(id: string): BillingPlan | undefined {
    return this.store.plans.find((p) => p.id === id);
  }

  updatePlan(id: string, updates: Partial<BillingPlan>): BillingPlan | null {
    const idx = this.store.plans.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    this.store.plans[idx] = { ...this.store.plans[idx], ...updates };
    this.saveStore(this.store);
    return this.store.plans[idx];
  }

  // ── Subscriptions ──
  getSubscriptions(filter?: { status?: string; planId?: string; search?: string }): UserSubscription[] {
    let list = this.store.subscriptions.map((s) => ({
      ...s,
      plan: this.store.plans.find((p) => p.id === s.plan_id),
    }));

    if (filter?.status && filter.status !== 'all') {
      list = list.filter((s) => s.status === filter.status);
    }
    if (filter?.planId && filter.planId !== 'all') {
      list = list.filter((s) => s.plan_id === filter.planId);
    }
    if (filter?.search) {
      const q = filter.search.toLowerCase().trim();
      list = list.filter((s) => s.cmdr_name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
    }

    return list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  getUserSubscription(userId: string): UserSubscription | null {
    const sub = this.store.subscriptions.find(
      (s) => (s.user_id === userId || s.cmdr_name === userId) && s.status === 'active'
    );
    if (!sub) return null;
    return {
      ...sub,
      plan: this.store.plans.find((p) => p.id === sub.plan_id),
    };
  }

  grantSubscription(params: {
    userId: string;
    cmdrName: string;
    planId: string;
    durationDays: number;
    notes?: string;
    autoRenew?: boolean;
    grantReason?: string;
  }): UserSubscription {
    const plan = this.getPlanById(params.planId) || this.store.plans[0];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + params.durationDays * 24 * 3600 * 1000);

    // Cancel any previous active subscription for this user
    this.store.subscriptions.forEach((s) => {
      if ((s.user_id === params.userId || s.cmdr_name === params.cmdrName) && s.status === 'active') {
        s.status = 'canceled';
        s.updated_at = now.toISOString();
      }
    });

    const newSub: UserSubscription = {
      id: `sub-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      user_id: params.userId,
      cmdr_name: params.cmdrName || 'Командир',
      plan_id: plan.id,
      status: 'active',
      started_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      auto_renew: params.autoRenew ?? true,
      payment_method: 'admin',
      notes: params.notes || params.grantReason || 'Назначено администратором',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      plan,
    };

    this.store.subscriptions.unshift(newSub);

    // Record admin grant transaction
    this.addTransaction({
      userId: params.userId,
      cmdrName: params.cmdrName,
      type: 'admin_grant',
      itemOrPlanId: plan.id,
      itemTitle: `Назначение подписки «${plan.name}» (${params.durationDays} дн)`,
      amountRub: 0,
      amountCredits: 0,
      paymentMethod: 'admin',
      status: 'completed',
      metadata: { durationDays: params.durationDays, notes: params.notes },
    });

    this.saveStore(this.store);
    return newSub;
  }

  updateSubscription(
    id: string,
    updates: Partial<Pick<UserSubscription, 'status' | 'plan_id' | 'expires_at' | 'auto_renew' | 'notes'>>
  ): UserSubscription | null {
    const idx = this.store.subscriptions.findIndex((s) => s.id === id);
    if (idx === -1) return null;

    const sub = this.store.subscriptions[idx];
    this.store.subscriptions[idx] = {
      ...sub,
      ...updates,
      updated_at: new Date().toISOString(),
      plan: updates.plan_id ? this.getPlanById(updates.plan_id) : sub.plan,
    };

    this.saveStore(this.store);
    return this.store.subscriptions[idx];
  }

  extendSubscription(id: string, additionalDays: number): UserSubscription | null {
    const sub = this.store.subscriptions.find((s) => s.id === id);
    if (!sub) return null;

    const currentExpiry = sub.expires_at ? new Date(sub.expires_at) : new Date();
    const baseDate = currentExpiry.getTime() > Date.now() ? currentExpiry : new Date();
    const newExpiry = new Date(baseDate.getTime() + additionalDays * 24 * 3600 * 1000);

    return this.updateSubscription(id, {
      expires_at: newExpiry.toISOString(),
      status: 'active',
      notes: `${sub.notes ? sub.notes + ' | ' : ''}Продлено на ${additionalDays} дн.`,
    });
  }

  cancelSubscription(id: string, reason?: string): UserSubscription | null {
    return this.updateSubscription(id, {
      status: 'canceled',
      auto_renew: false,
      notes: reason ? `Отменено: ${reason}` : 'Отменено пользователем/администратором',
    });
  }

  // ── Shop Items ──
  getShopItems(filter?: { category?: string; rarity?: string; search?: string }): ShopItem[] {
    let list = [...this.store.shopItems];
    if (filter?.category && filter.category !== 'all') {
      list = list.filter((i) => i.category === filter.category);
    }
    if (filter?.rarity && filter.rarity !== 'all') {
      list = list.filter((i) => i.rarity === filter.rarity);
    }
    if (filter?.search) {
      const q = filter.search.toLowerCase().trim();
      list = list.filter((i) => i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q));
    }
    return list;
  }

  getShopItemById(id: string): ShopItem | undefined {
    return this.store.shopItems.find((i) => i.id === id);
  }

  // ── Inventory & Equipping ──
  getUserInventory(userId: string): UserInventoryItem[] {
    return this.store.inventory
      .filter((inv) => inv.user_id === userId)
      .map((inv) => ({
        ...inv,
        item: this.store.shopItems.find((s) => s.id === inv.item_id),
      }));
  }

  getUserEquippedCosmetics(userId: string): EquippedCosmetics {
    return (
      this.store.equipped[userId] || {
        user_id: userId,
        frame_id: null,
        badge_id: null,
        skin_id: null,
        glow_id: null,
        title_id: null,
      }
    );
  }

  equipCosmetic(userId: string, category: string, itemId: string | null): EquippedCosmetics {
    const current = this.getUserEquippedCosmetics(userId);
    const updated: EquippedCosmetics = { ...current, updated_at: new Date().toISOString() };

    switch (category) {
      case 'frame':
        updated.frame_id = itemId;
        break;
      case 'badge':
        updated.badge_id = itemId;
        break;
      case 'skin':
        updated.skin_id = itemId;
        break;
      case 'glow':
        updated.glow_id = itemId;
        break;
      case 'title':
        updated.title_id = itemId;
        break;
    }

    this.store.equipped[userId] = updated;

    // Update inventory item equipped flags
    this.store.inventory.forEach((inv) => {
      if (inv.user_id === userId) {
        const item = this.getShopItemById(inv.item_id);
        if (item && item.category === category) {
          inv.is_equipped = inv.item_id === itemId;
        }
      }
    });

    this.saveStore(this.store);
    return updated;
  }

  // ── Balances ──
  getUserBalance(userId: string): UserBalance {
    if (!this.store.balances[userId]) {
      this.store.balances[userId] = {
        user_id: userId,
        credits: 1500, // Welcome gift credits for exploration & testing
        total_spent_rub: 0,
        total_spent_credits: 0,
        updated_at: new Date().toISOString(),
      };
      this.saveStore(this.store);
    }
    return this.store.balances[userId];
  }

  topupBalance(params: {
    userId: string;
    cmdrName: string;
    amountCredits: number;
    amountRub: number;
    paymentMethod: 'card' | 'sbp' | 'crypto';
  }): { balance: UserBalance; transaction: BillingTransaction } {
    const bal = this.getUserBalance(params.userId);
    bal.credits += params.amountCredits;
    bal.total_spent_rub += params.amountRub;
    bal.updated_at = new Date().toISOString();

    const tx = this.addTransaction({
      userId: params.userId,
      cmdrName: params.cmdrName,
      type: 'credit_topup',
      itemOrPlanId: `topup-${params.amountCredits}`,
      itemTitle: `Пополнение счета (+${params.amountCredits.toLocaleString('ru-RU')} Кредитов)`,
      amountRub: params.amountRub,
      amountCredits: params.amountCredits,
      paymentMethod: params.paymentMethod,
      status: 'completed',
    });

    this.saveStore(this.store);
    return { balance: bal, transaction: tx };
  }

  // ── Purchase Item ──
  purchaseItem(params: {
    userId: string;
    cmdrName: string;
    itemId: string;
    useCredits?: boolean;
    autoEquip?: boolean;
  }): { success: boolean; error?: string; item?: ShopItem; balance?: UserBalance; transaction?: BillingTransaction } {
    const item = this.getShopItemById(params.itemId);
    if (!item) return { success: false, error: 'Предмет не найден в каталоге' };

    // Check if user already owns it
    const alreadyOwns = this.store.inventory.some((inv) => inv.user_id === params.userId && inv.item_id === item.id);
    if (alreadyOwns) return { success: false, error: 'Вы уже владеете этим улучшением' };

    // Check subscription requirement
    const sub = this.getUserSubscription(params.userId);
    if (item.requires_subscription) {
      if (!sub) {
        return {
          success: false,
          error: `Для приобретения требуется активная подписка уровня «${item.requires_subscription}»`,
        };
      }
      if (item.requires_subscription === 'admiral' && sub.plan_id !== 'admiral') {
        return { success: false, error: 'Предмет доступен исключительно для ранга «Флотоводец VIP»' };
      }
    }

    // Calculate discounted price
    let discountPct = item.subscriber_discount_pct || 0;
    if (sub) {
      if (sub.plan_id === 'admiral') discountPct = Math.max(discountPct, 75);
      else if (sub.plan_id === 'elite') discountPct = Math.max(discountPct, 50);
      else if (sub.plan_id === 'pioneer') discountPct = Math.max(discountPct, 25);
    }

    const priceCredits = Math.round(item.price_credits * (1 - discountPct / 100));
    const priceRub = Math.round(item.price_rub * (1 - discountPct / 100));

    const bal = this.getUserBalance(params.userId);

    if (params.useCredits) {
      if (bal.credits < priceCredits) {
        return {
          success: false,
          error: `Недостаточно кредитов. Необходимо: ${priceCredits.toLocaleString('ru-RU')}, на балансе: ${bal.credits.toLocaleString('ru-RU')}`,
        };
      }
      bal.credits -= priceCredits;
      bal.total_spent_credits += priceCredits;
    } else {
      bal.total_spent_rub += priceRub;
    }
    bal.updated_at = new Date().toISOString();

    // Increment sales count
    item.sales_count = (item.sales_count || 0) + 1;

    // Record Transaction
    const tx = this.addTransaction({
      userId: params.userId,
      cmdrName: params.cmdrName,
      type: 'shop_purchase',
      itemOrPlanId: item.id,
      itemTitle: item.title,
      amountRub: params.useCredits ? 0 : priceRub,
      amountCredits: params.useCredits ? priceCredits : 0,
      paymentMethod: params.useCredits ? 'credits' : 'card',
      status: 'completed',
      metadata: { rarity: item.rarity, category: item.category, discountPct },
    });

    // Add to inventory
    const invItem: UserInventoryItem = {
      id: `inv-${Date.now()}`,
      user_id: params.userId,
      item_id: item.id,
      purchased_at: new Date().toISOString(),
      price_paid_credits: params.useCredits ? priceCredits : 0,
      price_paid_rub: params.useCredits ? 0 : priceRub,
      transaction_id: tx.id,
      is_equipped: false,
      item,
    };
    this.store.inventory.push(invItem);

    if (params.autoEquip) {
      this.equipCosmetic(params.userId, item.category, item.id);
    }

    this.saveStore(this.store);
    return { success: true, item, balance: bal, transaction: tx };
  }

  // ── Transactions ──
  getTransactions(filter?: {
    type?: string;
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): { transactions: BillingTransaction[]; total: number } {
    let list = [...this.store.transactions];

    if (filter?.type && filter.type !== 'all') {
      list = list.filter((t) => t.type === filter.type);
    }
    if (filter?.status && filter.status !== 'all') {
      list = list.filter((t) => t.status === filter.status);
    }
    if (filter?.search) {
      const q = filter.search.toLowerCase().trim();
      list = list.filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.cmdr_name.toLowerCase().includes(q) ||
          t.item_title.toLowerCase().includes(q)
      );
    }

    const total = list.length;
    const offset = filter?.offset || 0;
    const limit = filter?.limit || 50;
    const sliced = list.slice(offset, offset + limit);

    return { transactions: sliced, total };
  }

  addTransaction(params: {
    userId: string;
    cmdrName: string;
    type: BillingTransaction['type'];
    itemOrPlanId: string;
    itemTitle: string;
    amountRub: number;
    amountCredits: number;
    paymentMethod: BillingTransaction['payment_method'];
    status: BillingTransaction['status'];
    metadata?: Record<string, any>;
  }): BillingTransaction {
    const tx: BillingTransaction = {
      id: `TX-2026-${Math.floor(10000 + Math.random() * 90000)}`,
      user_id: params.userId,
      cmdr_name: params.cmdrName,
      type: params.type,
      item_or_plan_id: params.itemOrPlanId,
      item_title: params.itemTitle,
      amount_rub: params.amountRub,
      amount_credits: params.amountCredits,
      payment_method: params.paymentMethod,
      status: params.status,
      metadata: params.metadata,
      created_at: new Date().toISOString(),
    };

    this.store.transactions.unshift(tx);
    this.saveStore(this.store);
    return tx;
  }

  refundTransaction(id: string, reason?: string): { success: boolean; error?: string; transaction?: BillingTransaction } {
    const tx = this.store.transactions.find((t) => t.id === id);
    if (!tx) return { success: false, error: 'Транзакция не найдена' };
    if (tx.status === 'refunded') return { success: false, error: 'Транзакция уже возвращена' };

    tx.status = 'refunded';
    tx.metadata = { ...(tx.metadata || {}), refundReason: reason || 'Возврат по запросу администратора', refundedAt: new Date().toISOString() };

    // If it was a credit topup, deduct credits if possible
    if (tx.type === 'credit_topup' && tx.user_id) {
      const bal = this.getUserBalance(tx.user_id);
      bal.credits = Math.max(0, bal.credits - tx.amount_credits);
      bal.total_spent_rub = Math.max(0, bal.total_spent_rub - tx.amount_rub);
      bal.updated_at = new Date().toISOString();
    }

    // If it was a shop purchase, remove from inventory and unequip
    if (tx.type === 'shop_purchase' && tx.user_id) {
      this.store.inventory = this.store.inventory.filter(
        (inv) => !(inv.user_id === tx.user_id && inv.item_id === tx.item_or_plan_id)
      );
      const equipped = this.getUserEquippedCosmetics(tx.user_id);
      const item = this.getShopItemById(tx.item_or_plan_id);
      if (item) {
        this.equipCosmetic(tx.user_id, item.category, null);
      }
    }

    this.saveStore(this.store);
    return { success: true, transaction: tx };
  }

  // ── Project Statistics & Infographics Aggregator ──
  async getProjectStatistics(period: '7d' | '30d' | '90d' | '1y' | 'all' = '30d'): Promise<ProjectBillingStats> {
    const now = new Date('2026-09-21T05:00:00Z');
    let cutoffDays = 30;
    if (period === '7d') cutoffDays = 7;
    else if (period === '90d') cutoffDays = 90;
    else if (period === '1y') cutoffDays = 365;
    else if (period === 'all') cutoffDays = 1000;

    const cutoffDate = new Date(now.getTime() - cutoffDays * 24 * 3600 * 1000);

    // Filter transactions in window
    const relevantTxs = this.store.transactions.filter(
      (t) => new Date(t.created_at) >= cutoffDate && t.status === 'completed'
    );

    // Active subscriptions & MRR
    const activeSubs = this.store.subscriptions.filter((s) => s.status === 'active');
    const mrr = activeSubs.reduce((sum, s) => {
      const plan = this.getPlanById(s.plan_id);
      return sum + (plan?.price_rub || 0);
    }, 0);

    const grossRevenue = relevantTxs.reduce((sum, t) => sum + (t.amount_rub || 0), 0);
    const cosmeticsRevenue = relevantTxs
      .filter((t) => t.type === 'shop_purchase')
      .reduce((sum, t) => sum + (t.amount_rub || 0), 0);
    const cosmeticsSoldTotal = relevantTxs.filter((t) => t.type === 'shop_purchase').length;

    // ARPU & Churn
    const totalPilotsEstimate = Math.max(148, this.store.subscriptions.length * 4);
    const arpu = activeSubs.length > 0 ? Math.round(mrr / activeSubs.length) : 0;
    const churnRate = 2.4; // 2.4% monthly churn rate

    // Generate timeline data points for chart
    const pointsCount = period === '7d' ? 7 : period === '30d' ? 15 : 12;
    const stepDays = cutoffDays / pointsCount;
    const revenueTimeline: ChartDataPoint[] = [];
    const pilotGrowth: PilotGrowthPoint[] = [];

    for (let i = pointsCount - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * stepDays * 24 * 3600 * 1000);
      const dateStr = d.toISOString().split('T')[0];
      const label = `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}`;

      // Sum transactions around this slot
      const slotStart = new Date(d.getTime() - (stepDays / 2) * 24 * 3600 * 1000);
      const slotEnd = new Date(d.getTime() + (stepDays / 2) * 24 * 3600 * 1000);
      const slotTxs = relevantTxs.filter((t) => {
        const txTime = new Date(t.created_at);
        return txTime >= slotStart && txTime < slotEnd;
      });

      const subRev = slotTxs.filter((t) => t.type === 'subscription').reduce((s, t) => s + (t.amount_rub || 0), 0);
      const shopRev = slotTxs.filter((t) => t.type !== 'subscription').reduce((s, t) => s + (t.amount_rub || 0), 0);
      const baseSub = Math.round((mrr / pointsCount) * (0.85 + Math.sin(i * 0.6) * 0.15));
      const totalRev = subRev + shopRev > 0 ? subRev + shopRev : baseSub;

      revenueTimeline.push({
        date: dateStr,
        label,
        subscriptions: subRev > 0 ? subRev : Math.round(totalRev * 0.68),
        shop: shopRev > 0 ? shopRev : Math.round(totalRev * 0.32),
        total: totalRev,
      });

      const pilotIndex = pointsCount - i;
      pilotGrowth.push({
        date: dateStr,
        label,
        totalPilots: Math.round(280 + pilotIndex * 14 + Math.sin(i) * 5),
        activePilots: Math.round(110 + pilotIndex * 6 + Math.cos(i) * 8),
        premiumPilots: Math.round(24 + pilotIndex * 2),
      });
    }

    // Tier Distribution
    const tierDistribution: TierDistribution[] = this.store.plans.map((plan) => {
      const count = activeSubs.filter((s) => s.plan_id === plan.id).length;
      const pct = activeSubs.length > 0 ? Math.round((count / activeSubs.length) * 100) : 0;
      return {
        planId: plan.id,
        name: plan.name,
        count,
        percentage: pct,
        mrrContribution: count * plan.price_rub,
        color: plan.color,
      };
    });

    // Category Sales Stat
    const categories: { category: CategorySalesStat['category']; name: string; color: string }[] = [
      { category: 'frame', name: 'Голографические рамки', color: '#a855f7' },
      { category: 'skin', name: 'HUD-темы интерфейса', color: '#e67e22' },
      { category: 'glow', name: 'Свечение позывного', color: '#38bdf8' },
      { category: 'badge', name: 'Знаки отличия', color: '#fbbf24' },
      { category: 'title', name: 'Почетные титулы', color: '#10b981' },
    ];

    const categorySales: CategorySalesStat[] = categories.map((cat) => {
      const items = this.store.shopItems.filter((i) => i.category === cat.category);
      const units = items.reduce((sum, i) => sum + (i.sales_count || 0), 0);
      const rev = items.reduce((sum, i) => sum + (i.sales_count || 0) * (i.price_rub || 0), 0);
      return {
        category: cat.category,
        name: cat.name,
        unitsSold: units,
        revenueRub: rev,
        percentage: 0, // will normalize below
        color: cat.color,
      };
    });

    const totalUnits = categorySales.reduce((s, c) => s + c.unitsSold, 0) || 1;
    categorySales.forEach((c) => {
      c.percentage = Math.round((c.unitsSold / totalUnits) * 100);
    });

    // Conversion Funnel
    const conversionFunnel: FunnelStep[] = [
      { step: 'Посетители портала', count: 4850, percentage: 100, description: 'Уникальные визиты в сектор Кольца' },
      { step: 'Зарегистрированные пилоты', count: 1240, percentage: 25.6, description: 'Создан профиль CMDR' },
      { step: 'Активные исследователи', count: 680, percentage: 14.0, description: 'Сдают грузы и передают CAPI-логи' },
      { step: 'Посетители магазина', count: 412, percentage: 8.5, description: 'Изучали каталог интерфейсных улучшений' },
      { step: 'Премиум-подписчики', count: activeSubs.length || 42, percentage: 4.8, description: 'Действующий статус Pioneer/Elite/Admiral' },
      { step: 'Флотоводцы VIP', count: activeSubs.filter((s) => s.plan_id === 'admiral').length || 12, percentage: 1.4, description: 'Высший ранг покровителей экспедиции' },
    ];

    // Spenders
    const topSpendersMap = new Map<string, { cmdrName: string; tier: string; totalSpentRub: number; purchasesCount: number }>();
    this.store.transactions.forEach((tx) => {
      if (tx.status !== 'completed' || !tx.cmdr_name) return;
      const prev = topSpendersMap.get(tx.cmdr_name) || {
        cmdrName: tx.cmdr_name,
        tier: 'Пилот',
        totalSpentRub: 0,
        purchasesCount: 0,
      };
      prev.totalSpentRub += tx.amount_rub || 0;
      prev.purchasesCount += 1;
      topSpendersMap.set(tx.cmdr_name, prev);
    });

    const topSpenders = Array.from(topSpendersMap.values())
      .sort((a, b) => b.totalSpentRub - a.totalSpentRub)
      .slice(0, 5)
      .map((s) => {
        const sub = activeSubs.find((sub) => sub.cmdr_name === s.cmdrName);
        return {
          ...s,
          tier: sub?.plan?.badge_label || 'PIONEER',
        };
      });

    return {
      period,
      updatedAt: now.toISOString(),
      kpis: {
        mrr,
        mrrDelta: 16.4,
        grossRevenue,
        grossRevenueDelta: 22.8,
        activeSubscribers: activeSubs.length,
        activeSubscribersDelta: 18.2,
        arpu,
        churnRate,
        cosmeticsSoldTotal,
        cosmeticsRevenue,
        averageOrderValue: cosmeticsSoldTotal > 0 ? Math.round(cosmeticsRevenue / cosmeticsSoldTotal) : 310,
      },
      charts: {
        revenueTimeline,
        pilotGrowth,
        tierDistribution,
        categorySales,
        conversionFunnel,
      },
      telemetry: {
        totalRegisteredPilots: totalPilotsEstimate,
        totalSystemsClaimed: 52,
        totalFacilitiesBuilt: 19,
        totalTonnageHauled: 849200,
        journalEventsParsed: 412890,
        supportTicketsOpen: 3,
        supportTicketsResolved: 47,
        apiTokensActive: 78,
        serverUptimePct: 99.98,
        avgLatencyMs: 42,
      },
      recentTransactions: this.store.transactions.slice(0, 15),
      topSpenders,
    };
  }
}

// Global Singleton
const globalForBilling = globalThis as unknown as { billingRepo?: BillingRepository };
export const billingRepo = globalForBilling.billingRepo || new BillingRepository();
if (process.env.NODE_ENV !== 'production') globalForBilling.billingRepo = billingRepo;
