#!/usr/bin/env node
/**
 * Генератор каталога туманностей для 3D-карты галактики.
 *
 * Зачем скрипт, а не рукописный файл данных: координаты в Elite Dangerous у
 * «настоящих» туманностей не выдуманы — игра ставит реальный объект в ту же
 * точку неба (RA/Dec, J2000), что и в реальном каталоге, и только расстояние
 * берёт своё (игровое). Поэтому координаты считаются из двух источников:
 *
 *   1. RA/Dec — каталог OpenNGC (https://github.com/mattiaverga/OpenNGC,
 *      CC-BY-SA-4.0) либо собственные значения для объектов, которых там нет
 *      (IC 405/418/434/443/289, M45, тёмные области — они помечены в таблице).
 *   2. `dist` — расстояние от Sol из списка туманностей игры
 *      (Elite Dangerous Wiki «Nebula» + тема Frontier «Complete List of (real)
 *      Nebulae and Galaxies in Elite»). Игра использует именно эти дистанции.
 *
 * Проверка метода: посчитанные координаты совпадают с реальными системами
 * игры (Maia, HIP 23759, HD 36917, California Sector LX-T b3-0 и др.) с
 * ошибкой в единицы-десятки св. лет — это видно в `--verify`.
 *
 * Запуск:  node scripts/build-nebula-catalog.mjs [--verify]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/lib/galaxyNebulae.ts');

/* ── Небесная механика ───────────────────────────────────────────────────── */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Полюс Галактики и gal. долгота 0 (J2000), как в стандарте IAU. */
const POLE = { ra: 192.85948 * D2R, dec: 27.12825 * D2R };
const GC = { ra: 266.40499 * D2R, dec: -28.93617 * D2R };

function parseSexagesimal(value) {
  const text = String(value).trim();
  const sign = text.startsWith('-') ? -1 : 1;
  const parts = text.replace(/^[+-]/, '').split(':').map(Number);
  return sign * (parts[0] + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600);
}

/** RA в часах, Dec в градусах/минутах/секундах → градусы. */
function raHoursToDeg(ra) {
  return parseSexagesimal(ra) * 15;
}

const vec = {
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
};

/** Экваториальные (градусы) → галактические l/b (градусы). */
export function equatorialToGalactic(raDeg, decDeg) {
  const pole = [Math.cos(POLE.dec) * Math.cos(POLE.ra), Math.cos(POLE.dec) * Math.sin(POLE.ra), Math.sin(POLE.dec)];
  const centre = [Math.cos(GC.dec) * Math.cos(GC.ra), Math.cos(GC.dec) * Math.sin(GC.ra), Math.sin(GC.dec)];
  const eZ = pole;
  const eX = centre;
  const eY = vec.cross(eZ, eX);
  const ra = raDeg * D2R;
  const dec = decDeg * D2R;
  const star = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  const xg = vec.dot(star, eX);
  const yg = vec.dot(star, eY);
  const zg = vec.dot(star, eZ);
  return {
    l: (Math.atan2(yg, xg) * R2D + 360) % 360,
    b: Math.asin(Math.max(-1, Math.min(1, zg))) * R2D,
  };
}

/**
 * Позиция в координатах Elite Dangerous: x — на центр Галактики, z — на Sol,
 * y — вверх (северный галактический полюс). Расстояние — игровое.
 */
export function eliteCoords(raDeg, decDeg, distance) {
  const { l, b } = equatorialToGalactic(raDeg, decDeg);
  const lr = l * D2R;
  const br = b * D2R;
  return {
    x: -distance * Math.sin(lr) * Math.cos(br),
    y: distance * Math.sin(br),
    z: distance * Math.cos(lr) * Math.cos(br),
    l,
    b,
  };
}

/* ── Таблица туманностей игры ───────────────────────────────────────────── */

/**
 * kind:      emission | reflection | cluster | dark | planetary | remnant
 * dist:      расстояние от Sol (св. лет) — значение из игры
 * size:      видимый диаметр облака на карте галактики (св. лет). Задаётся
 *            вручную там, где форма важна; иначе считается из углового размера
 *            самого объекта (maj) с поправкой на «свечение» карты.
 * maj:       угловой размер объекта, минут дуги (из OpenNGC).
 * color:     цвет облака на карте галактики.
 * ref:       реальная система игры внутри туманности (для карточки и перехода).
 * refCoords: точные координаты этой системы из EDSM — позиция облака берётся
 *            по ним, а не по расчёту (игра ставит облако вокруг системы).
 * lobes:     дополнительные центры (для составных облаков вроде Сердца и Души).
 * refCoords: точные координаты этой системы из EDSM — позиция облака берётся
 *            по ним, а не по расчёту (игра ставит облако вокруг системы).
 * lobes:     дополнительные центры (для составных облаков вроде Сердца и Души).
 * major:     подписывать на карте.
 */
const NEBULAE = [
  /* ─── Внутренний рукав: Пузырь и окрестности Sol ─── */
  { name: 'Pleiades Nebula', ru: 'Плеяды', kind: 'cluster', dist: 380, ra: '03:47:24', dec: '+24:07:00', maj: 110, size: 170, color: '#6f9bff', ref: 'Maia', refCoords: { x: -81.78125, y: -149.4375, z: -343.375 }, major: true, note: 'Ближайшее звёздное скопление с отражательной туманностью; столица региона — Майя.' },
  { name: 'R CrA Nebula', ru: 'Туманность R Южной Короны', kind: 'reflection', dist: 420, ra: '19:01:55.40', dec: '-36:57:27.5', maj: 25, color: '#d9a05f', ref: 'R CrA', note: 'Область звездообразования; в игре рядом астероидная база.' },
  { name: 'Taurus Dark Region', ru: 'Тёмная область Тельца', kind: 'dark', dist: 460, ra: '04:32:00', dec: '+25:30:00', maj: 300, color: '#101725', manual: true },
  { name: 'The Lupus Dark Regions', ru: 'Тёмные области Волка', kind: 'dark', dist: 460, ra: '15:56:00', dec: '-37:30:00', maj: 200, color: '#101725', manual: true },
  { name: 'Pipe Bowl and Stem', ru: 'Трубка (чаша и чубук)', kind: 'dark', dist: 480, ra: '17:15:00', dec: '-26:30:00', maj: 300, color: '#0e1522', manual: true },
  { name: 'Coalsack Nebula', ru: 'Мешок Угля', kind: 'dark', dist: 500, ra: '12:31:19', dec: '-63:44:36', maj: 420, size: 230, color: '#0c1220', note: 'Самый известный тёмный «провал» звёздного неба.' },
  { name: 'Rho Ophiuchi', ru: 'Ро Змееносца', kind: 'reflection', dist: 500, ra: '16:25:31.17', dec: '-23:26:11.7', maj: 60, color: '#8f7fd0', major: true },
  { name: 'The Ophiuchus Dark Regions', ru: 'Тёмные области Змееносца', kind: 'dark', dist: 500, ra: '16:28:00', dec: '-24:30:00', maj: 240, color: '#101725', manual: true },
  { name: 'Corona Australis Dark Region', ru: 'Тёмная область Южной Короны', kind: 'dark', dist: 510, ra: '19:00:00', dec: '-37:30:00', maj: 180, color: '#101725', manual: true },
  { name: "Struve's Lost Nebula", ru: 'Потерянная туманность Струве', kind: 'reflection', dist: 500, ra: '04:22:00', dec: '+19:33:00', maj: 6, color: '#c8a0e0', manual: true },
  { name: 'Scorpius Dark Region', ru: 'Тёмная область Скорпиона', kind: 'dark', dist: 500, ra: '16:25:00', dec: '-34:00:00', maj: 200, color: '#101725', manual: true },
  { name: 'Musca Dark Region', ru: 'Тёмная область Мухи', kind: 'dark', dist: 500, ra: '12:45:00', dec: '-71:00:00', maj: 180, color: '#101725', manual: true },
  { name: 'Hind Nebula', ru: 'Туманность Хайнда', kind: 'reflection', dist: 595, ra: '04:21:57', dec: '+19:32:07', maj: 12, color: '#d08a6a', manual: true },
  { name: 'LBN 623', ru: 'LBN 623', kind: 'dark', dist: 600, ra: '21:34:00', dec: '+67:50:00', maj: 120, color: '#101725', manual: true },
  { name: 'Chamaeleon Nebula', ru: 'Туманность Хамелеон', kind: 'dark', dist: 600, ra: '10:55:00', dec: '-77:00:00', maj: 240, color: '#0e1522', manual: true },
  { name: 'IC 4604', ru: 'IC 4604', kind: 'reflection', dist: 600, ra: '16:25:31.17', dec: '-23:26:11.7', maj: 60, color: '#7f9fe0' },
  { name: 'Snake Nebula', ru: 'Туманность Змея', kind: 'dark', dist: 600, ra: '17:23:30', dec: '-23:38:00', maj: 60, color: '#0e1522', manual: true },
  { name: 'B92', ru: 'B92', kind: 'dark', dist: 650, ra: '18:15:24', dec: '-18:04:00', maj: 20, color: '#0e1522', manual: true },
  { name: 'Vulpecula Dark Region', ru: 'Тёмная область Лисички', kind: 'dark', dist: 650, ra: '19:41:00', dec: '+23:30:00', maj: 180, color: '#101725', manual: true },
  { name: 'Scutum Dark Region', ru: 'Тёмная область Щита', kind: 'dark', dist: 650, ra: '18:42:00', dec: '-06:00:00', maj: 200, color: '#101725', manual: true },
  { name: 'Helix Nebula', ru: 'Туманность Улитка', kind: 'planetary', dist: 700, ra: '22:29:38.57', dec: '-20:50:14.4', maj: 16.33, color: '#4fbfc0', major: true },
  { name: 'NGC 1501', ru: 'NGC 1501', kind: 'planetary', dist: 3583, ra: '04:06:59.4', dec: '+60:55:14', maj: 0.87, color: '#68c8d0', ref: 'GCRV 2334', refCoords: { x: -2071.59375, y: 413.75, z: -2915.03125 } },
  { name: 'Fireflies Nebula', ru: 'Туманность Светлячки', kind: 'planetary', dist: 5928, ra: '02:35:18.97', dec: '+61:31:23.6', maj: 0.5, color: '#7fd0b0', ref: '2MASS J02351897+6131236', refCoords: { x: -4192.71875, y: 114.5, z: -4190.625 } },
  { name: 'Chi Persei Nebula', ru: 'Туманность Хи Персея', kind: 'cluster', dist: 7624, ra: '02:20:00', dec: '+57:08:00', maj: 60, size: 220, color: '#8fb0e8', manual: true, refCoords: { x: -5381.90625, y: -472.78125, z: -5383.59375 } },
  { name: 'Eskimo Nebula', ru: 'Туманность Эскимос', kind: 'planetary', dist: 800, ra: '07:29:10.76', dec: '+20:54:42.6', maj: 0.86, color: '#57c8c0' },
  { name: 'Pencil Nebula NGC 2736', ru: 'Туманность Карандаш', kind: 'remnant', dist: 815, ra: '09:00:16.94', dec: '-45:56:53.0', maj: 30, size: 150, color: '#d06a6a', shape: 'filament' },
  { name: 'NGC 1514', ru: 'NGC 1514', kind: 'planetary', dist: 860, ra: '04:09:16.95', dec: '+30:46:33.3', maj: 2.2, color: '#6ec6e0' },
  { name: 'Witch Head Nebula', ru: 'Туманность Ведьмина голова', kind: 'reflection', dist: 890, ra: '05:04:55.44', dec: '-07:15:56.3', maj: 150, size: 140, color: '#5b86c9', ref: 'HIP 23759', refCoords: { x: 359.84375, y: -385.53125, z: -718.375 }, major: true },
  { name: 'California Nebula', ru: 'Туманность Калифорния', kind: 'emission', dist: 975, ra: '04:03:14.42', dec: '+36:22:02.9', maj: 160, size: 210, color: '#d8456b', ref: 'California Sector LX-T b3-0', refCoords: { x: -337.90625, y: -211.9375, z: -927.03125 }, major: true, shape: 'elongated' },
  { name: 'Aquila Dark Region', ru: 'Тёмная область Орла', kind: 'dark', dist: 990, ra: '19:20:44', dec: '+11:11:00', maj: 90, color: '#101725', manual: true },
  { name: 'Shapley 1', ru: 'Шепли 1', kind: 'planetary', dist: 1000, ra: '15:51:42', dec: '-51:31:30', maj: 1.1, color: '#67d0c8', manual: true },
  { name: 'IC 1287', ru: 'IC 1287', kind: 'reflection', dist: 1000, ra: '18:31:25.69', dec: '-10:47:44.9', maj: 20, color: '#7f9fe0' },
  { name: "Parrot's Head", ru: 'Голова попугая', kind: 'dark', dist: 1000, ra: '17:35:00', dec: '-30:00:00', maj: 60, color: '#0e1522', manual: true },
  { name: 'Dumbbell Nebula', ru: 'Туманность Гантель', kind: 'planetary', dist: 1100, ra: '19:59:36.38', dec: '+22:43:15.7', maj: 6.7, color: '#5fc8a0', major: true },
  { name: 'NGC 1333', ru: 'NGC 1333', kind: 'reflection', dist: 1100, ra: '03:29:02', dec: '+31:21:00', maj: 6, color: '#8fb0e8', manual: true },
  { name: 'Spirograph Nebula', ru: 'Туманность Спирограф', kind: 'planetary', dist: 1100, ra: '05:27:28.2', dec: '-12:41:50', maj: 0.2, color: '#4ec9d9', ref: 'BD-12 1172', refCoords: { x: 577.875, y: -452.6875, z: -819.25 }, manual: true, major: true },
  { name: 'NGC 1999', ru: 'NGC 1999', kind: 'reflection', dist: 1140, ra: '05:36:25.35', dec: '-06:42:57.1', maj: 2, color: '#9fb8e8', ref: 'V380 Orionis', refCoords: { x: 549.34375, y: -374.53125, z: -926.59375 } },
  { name: 'NGC 1360', ru: 'NGC 1360', kind: 'planetary', dist: 1145, ra: '03:33:14.65', dec: '-25:52:18.2', maj: 6.42, color: '#6fd7d0' },
  { name: 'Orion Nebula', ru: 'Туманность Ориона', kind: 'emission', dist: 1300, ra: '05:35:16.48', dec: '-05:23:22.8', maj: 90, size: 220, color: '#e0629b', ref: 'HD 36917', refCoords: { x: 593.3125, y: -433.53125, z: -1065.03125 }, major: true, note: 'Главная достопримечательность Ориона: звёздные ясли с яркой сердцевиной.' },
  { name: 'Running Man Nebula', ru: 'Туманность Бегущий человек', kind: 'reflection', dist: 1300, ra: '05:35:15.80', dec: '-04:50:39.6', maj: 10.2, color: '#7fa8e8', ref: 'V1745 Orionis', refCoords: { x: 587.84375, y: -425.40625, z: -1077.5625 } },
  { name: 'Messier 78', ru: 'Мессье 78', kind: 'reflection', dist: 1300, ra: '05:46:45.82', dec: '+00:04:45.5', maj: 4.5, color: '#8fa8e8' },
  { name: "Barnard's Loop", ru: 'Петля Барнарда', kind: 'emission', dist: 1400, ra: '05:41:00', dec: '-03:30:00', maj: 600, size: 620, color: '#c83a5b', shape: 'arc', manual: true, major: true,
    ref: 'Trapezium Sector AF-Z c0', refCoords: { x: 617.03125, y: -421.625, z: -1224.5625 }, note: 'Огромная дуга вокруг Пояса Ориона — видна на карте галактики как кольцо.' },
  { name: 'NGC 3242', ru: 'Призрак Юпитера', kind: 'planetary', dist: 1400, ra: '10:24:46.08', dec: '-18:38:32.0', maj: 0.42, color: '#5fc8d8' },
  { name: 'Horsehead Dark Region', ru: 'Тёмная область Конской головы', kind: 'dark', dist: 1400, ra: '05:40:59.0', dec: '-02:27:30', maj: 6, size: 110, color: '#120c18', shape: 'silhouette', sharp: true },
  { name: 'Cepheus Dark Region', ru: 'Тёмная область Цефея', kind: 'dark', dist: 1400, ra: '21:02:00', dec: '+68:30:00', maj: 200, color: '#101725', manual: true },
  { name: 'Puppis Dark Region B', ru: 'Тёмная область Кормы B', kind: 'dark', dist: 1400, ra: '07:30:00', dec: '-35:00:00', maj: 200, color: '#101725', manual: true },
  { name: 'Flame Nebula', ru: 'Туманность Пламя', kind: 'emission', dist: 1410, ra: '05:41:42.57', dec: '-01:51:22.6', maj: 30, size: 130, color: '#e0764a', ref: 'Trapezium Sector AF-Z c5', refCoords: { x: 625.75, y: -401.53125, z: -1198.53125 } },
  { name: 'Veil Nebula West', ru: 'Вуаль: запад', kind: 'remnant', dist: 1470, ra: '20:45:38', dec: '+30:42:30', maj: 70, size: 200, color: '#c05a72', shape: 'filament', manual: true,
    ref: 'Veil West Sector DL-Y d68', refCoords: { x: -1398.25, y: -193.5625, z: 418.90625 } },
  { name: 'Horsehead Nebula', ru: 'Туманность Конская голова', kind: 'emission', dist: 1500, ra: '05:41:00', dec: '-02:24:00', maj: 60, size: 120, color: '#b8465f', manual: true },
  { name: 'Orion Dark Region', ru: 'Тёмная область Ориона', kind: 'dark', dist: 1500, ra: '05:47:00', dec: '-01:00:00', maj: 300, color: '#101725', manual: true },
  { name: 'Iris Nebula', ru: 'Туманность Ирис', kind: 'reflection', dist: 1500, ra: '21:01:35.62', dec: '+68:10:10.4', maj: 10, color: '#7f9fe0' },
  { name: 'Puppis Dark Region', ru: 'Тёмная область Кормы', kind: 'dark', dist: 1500, ra: '08:05:00', dec: '-32:00:00', maj: 260, color: '#101725', manual: true },
  { name: 'IC 405 - Flaming Star Nebula', ru: 'Туманность Пылающая звезда', kind: 'emission', dist: 1500, ra: '05:16:12', dec: '+34:16:00', maj: 37, size: 170, color: '#e8973f', ref: 'Flaming Star Sector GW-W c1-4', refCoords: { x: -233.5, y: -67.1875, z: -1681.3125 }, manual: true, major: true },
  { name: 'IC 289', ru: 'IC 289', kind: 'planetary', dist: 1700, ra: '03:10:19.3', dec: '+61:19:01', maj: 0.9, color: '#63cfd8', manual: true },
  { name: 'Spiral Planetary Nebula', ru: 'Спиральная планетарная туманность', kind: 'planetary', dist: 1780, ra: '13:33:32.91', dec: '-65:58:26.6', maj: 2.33, color: '#68c8d8' },
  { name: 'Sadr Region', ru: 'Область Садр', kind: 'emission', dist: 1800, ra: '20:22:13.69', dec: '+40:15:24.1', maj: 180, size: 240, color: '#c2607a' },
  { name: 'North America Nebula', ru: 'Туманность Северная Америка', kind: 'emission', dist: 1900, ra: '20:59:17.14', dec: '+44:31:43.6', maj: 120, size: 260, color: '#d1485f', major: true },
  { name: 'Pelican Nebula', ru: 'Туманность Пеликан', kind: 'emission', dist: 1900, ra: '20:51:00.72', dec: '+44:24:05.4', maj: 60, size: 180, color: '#c8556e' },
  { name: 'B352', ru: 'B352', kind: 'dark', dist: 1900, ra: '20:20:00', dec: '+40:00:00', maj: 60, color: '#0e1522', manual: true },
  { name: 'Veil Nebula East', ru: 'Вуаль: восток', kind: 'remnant', dist: 1970, ra: '20:56:24', dec: '+31:43:00', maj: 70, size: 200, color: '#4fb0a5', shape: 'filament', manual: true },
  { name: 'Blinking Nebula', ru: 'Мерцающая туманность', kind: 'planetary', dist: 2000, ra: '19:44:48.11', dec: '+50:31:30.1', maj: 0.42, color: '#63cfc0' },
  { name: 'Eight Burst Nebula', ru: 'Туманность Восемь вспышек', kind: 'planetary', dist: 2100, ra: '10:07:01.73', dec: '-40:26:11.7', maj: 0.5, color: '#5fc8c8' },
  { name: 'Little Dumbbell Nebula', ru: 'Малая Гантель', kind: 'planetary', dist: 2100, ra: '01:42:19.9', dec: '+51:34:31', maj: 2.7, color: '#5fc8b0', manual: true },
  { name: 'Ring Nebula', ru: 'Туманность Кольцо', kind: 'planetary', dist: 2200, ra: '18:53:35.01', dec: '+33:01:42.9', maj: 1.27, color: '#5fd0a8', major: true },
  { name: 'Cone Nebula', ru: 'Туманность Конус', kind: 'emission', dist: 2200, ra: '06:40:58.25', dec: '+09:53:43.7', maj: 11.4, color: '#c05a72' },
  { name: 'M97 (Owl Nebula)', ru: 'Туманность Сова', kind: 'planetary', dist: 2200, ra: '11:14:47.7', dec: '+55:01:09', maj: 3.4, color: '#63c9a6', manual: true },
  { name: 'Cave Nebula', ru: 'Туманность Пещера', kind: 'emission', dist: 2400, ra: '22:57:54', dec: '+62:31:06', maj: 50, size: 180, color: '#c9526b' },
  { name: 'NGC 6884', ru: 'NGC 6884', kind: 'planetary', dist: 2500, ra: '20:10:23.70', dec: '+46:27:39.0', maj: 0.1, color: '#5fc8c0' },
  { name: 'Trifid of the North Nebula', ru: 'Северный Тройник', kind: 'emission', dist: 2600, ra: '04:30:13.80', dec: '+35:16:10.0', maj: 10.2, color: '#cf5f9b' },
  { name: "Elephant's Trunk Nebula", ru: 'Туманность Хобот слона', kind: 'emission', dist: 2650, ra: '21:38:57.62', dec: '+57:29:20.6', maj: 170, size: 230, color: '#c85b7a' },
  { name: 'NGC 7822', ru: 'Туманность NGC 7822', kind: 'emission', dist: 2790, ra: '00:03:35.35', dec: '+67:09:41.9', maj: 20, size: 420, color: '#c2447a', major: true, note: 'Огромная область звездообразования у кластера Berkeley 59.' },
  { name: 'Fetus Nebula', ru: 'Туманность Эмбрион', kind: 'planetary', dist: 2900, ra: '21:00:32.80', dec: '+54:32:35.5', maj: 1.43, color: '#68c8c0' },
  { name: 'Blue Flash', ru: 'Синяя вспышка', kind: 'planetary', dist: 3000, ra: '20:22:22.99', dec: '+20:06:16.3', maj: 0.67, color: '#6fb0e8' },
  { name: 'IC 5117', ru: 'IC 5117', kind: 'planetary', dist: 3000, ra: '21:32:30.97', dec: '+44:35:47.6', maj: 0.02, color: '#68c8d8' },
  { name: 'Butterfly Nebula', ru: 'Туманность Бабочка', kind: 'planetary', dist: 3000, ra: '07:09:23.01', dec: '-00:48:32.9', maj: 0.87, color: '#8f7fe0' },
  { name: 'Red Spider Nebula', ru: 'Красный паук', kind: 'planetary', dist: 3000, ra: '18:05:13.10', dec: '-19:50:34.7', maj: 0.17, color: '#e0705f' },
  { name: 'Retina Nebula', ru: 'Туманность Сетчатка', kind: 'planetary', dist: 3000, ra: '14:22:26.48', dec: '-44:09:00.7', maj: 0.58, color: '#68c0d8' },
  { name: 'Cocoon Nebula', ru: 'Туманность Кокон', kind: 'emission', dist: 3200, ra: '21:53:28.76', dec: '+47:16:00.9', maj: 10, color: '#d0a05f' },
  { name: 'NGC 2438', ru: 'NGC 2438', kind: 'planetary', dist: 3200, ra: '07:41:50.39', dec: '-14:44:08.8', maj: 1.07, color: '#63c8c0' },
  { name: 'NGC 6302', ru: 'Туманность Жук', kind: 'planetary', dist: 3400, ra: '17:13:44.63', dec: '-37:06:11.3', maj: 0.74, color: '#8f7fe0' },
  { name: 'NGC 7027', ru: 'NGC 7027', kind: 'planetary', dist: 3400, ra: '21:07:01.53', dec: '+42:14:11.5', maj: 0.23, color: '#6fd0c8' },
  { name: 'Bow-Tie Nebula', ru: 'Туманность Галстук-бабочка', kind: 'planetary', dist: 3500, ra: '00:13:01.0', dec: '+72:31:19', maj: 0.6, color: '#6fc8e0', manual: true },
  { name: "Thor's Helmet", ru: 'Шлем Тора', kind: 'emission', dist: 3660, ra: '07:18:30.98', dec: '-13:13:37.9', maj: 10, size: 160, color: '#59a8c8', ref: 'NGC 2359', major: true },
  { name: 'Seagull Nebula', ru: 'Туманность Чайка', kind: 'emission', dist: 3770, ra: '07:04:36.91', dec: '-10:28:15.8', maj: 20, size: 190, color: '#cf6a72' },
  { name: 'NGC 7354', ru: 'NGC 7354', kind: 'planetary', dist: 4200, ra: '22:40:19.61', dec: '+61:17:05.4', maj: 0.38, color: '#68c8c8' },
  { name: 'NGC 6188', ru: 'Туманность NGC 6188', kind: 'emission', dist: 4400, ra: '16:40:05.84', dec: '-48:39:44.2', maj: 20, size: 200, color: '#c85b8a', major: true },
  { name: 'Lagoon Nebula', ru: 'Туманность Лагуна', kind: 'emission', dist: 4500, ra: '18:03:41.27', dec: '-24:22:48.6', maj: 45, size: 230, color: '#df5f8a', major: true },
  { name: 'NGC 3699', ru: 'NGC 3699', kind: 'planetary', dist: 4500, ra: '11:27:57.15', dec: '-59:57:29.0', maj: 0.75, color: '#68c8b8' },
  { name: 'Lemon Slice Nebula', ru: 'Туманность Ломтик лимона', kind: 'planetary', dist: 4500, ra: '12:33:06.78', dec: '+82:33:50.1', maj: 0.38, color: '#6fc8e8' },
  { name: 'Little Ghost Nebula', ru: 'Маленькое привидение', kind: 'planetary', dist: 4900, ra: '17:29:20.50', dec: '-23:45:34.0', maj: 0.63, color: '#63c8c8' },
  { name: 'NGC 6337', ru: 'NGC 6337', kind: 'planetary', dist: 4900, ra: '17:22:15.7', dec: '-38:29:02', maj: 0.85, color: '#6fd0c0', manual: true },
  { name: 'Jellyfish Nebula', ru: 'Туманность Медуза', kind: 'remnant', dist: 4990, ra: '06:17:13', dec: '+22:31:05', maj: 45, size: 160, color: '#6fc4c8', manual: true },
  { name: 'Blue Planetary Nebula', ru: 'Голубая планетарная туманность', kind: 'planetary', dist: 5000, ra: '11:50:17.95', dec: '-57:10:56.4', maj: 0.32, color: '#5fa8e8' },
  { name: 'NGC 6804', ru: 'NGC 6804', kind: 'planetary', dist: 5000, ra: '19:31:35.39', dec: '+09:13:30.6', maj: 0.58, color: '#63c8c0' },
  { name: 'Crescent Nebula', ru: 'Туманность Полумесяц', kind: 'emission', dist: 5000, ra: '20:12:06.55', dec: '+38:21:17.8', maj: 20, size: 150, color: '#5fa8c8', major: true },
  { name: 'NGC 6852', ru: 'NGC 6852', kind: 'planetary', dist: 5000, ra: '20:00:39.16', dec: '+01:43:41.2', maj: 0.47, color: '#63c8c0' },
  { name: 'NGC 6781', ru: 'NGC 6781', kind: 'planetary', dist: 5100, ra: '19:18:28.26', dec: '+06:32:23.0', maj: 1.8, color: '#68c8b8' },
  { name: 'Trifid Nebula', ru: 'Туманность Тройная', kind: 'emission', dist: 5200, ra: '18:02:42.11', dec: '-22:58:18.8', maj: 28, size: 190, color: '#cf5f9b', major: true },
  { name: 'Rosette Nebula', ru: 'Туманность Розетка', kind: 'emission', dist: 5300, ra: '06:30:54.61', dec: '+05:02:57.0', maj: 80, size: 300, color: '#e0607a', major: true },
  { name: "Cat's Paw Nebula - NGC 6334", ru: 'Туманность Кошачья лапа', kind: 'emission', dist: 5500, ra: '17:20:49.70', dec: '-36:06:09.8', maj: 8.4, size: 170, color: '#d14f6b' },
  { name: 'Omega Nebula', ru: 'Туманность Омега', kind: 'emission', dist: 5500, ra: '18:20:47.11', dec: '-16:10:17.5', maj: 12.6, size: 180, color: '#d0648a', major: true },
  { name: 'NGC 6357', ru: 'NGC 6357', kind: 'emission', dist: 5500, ra: '17:24:43.57', dec: '-34:12:04.8', maj: 3.9, size: 190, color: '#c85b8a' },
  { name: 'NGC 7048', ru: 'NGC 7048', kind: 'planetary', dist: 5600, ra: '21:14:15.20', dec: '+46:17:19.0', maj: 1.02, color: '#63c8c8' },
  { name: 'NGC 2440', ru: 'NGC 2440', kind: 'planetary', dist: 5700, ra: '07:41:55.36', dec: '-18:12:30.5', maj: 0.27, color: '#68c8c0' },
  { name: 'NGC 6803', ru: 'NGC 6803', kind: 'planetary', dist: 5700, ra: '19:31:16.45', dec: '+10:03:21.7', maj: 0.09, color: '#63c8c0' },
  { name: 'NGC 6565', ru: 'NGC 6565', kind: 'planetary', dist: 5900, ra: '18:11:52.60', dec: '-28:10:42.0', maj: 0.23, color: '#68c8d0' },
  { name: 'Little Gem Nebula', ru: 'Маленькая жемчужина', kind: 'planetary', dist: 6000, ra: '19:43:57.73', dec: '-14:09:11.4', maj: 0.77, color: '#63c8c0' },
  { name: 'Statue of Liberty Nebula', ru: 'Туманность Статуя Свободы', kind: 'emission', dist: 6000, ra: '11:11:31.67', dec: '-61:21:46.8', maj: 3, size: 150, color: '#6f9fd8', major: true },
  { name: 'NGC 6842', ru: 'NGC 6842', kind: 'planetary', dist: 6000, ra: '19:55:02.26', dec: '+29:17:21.0', maj: 0.95, color: '#63c8c0' },
  { name: 'NGC 7026', ru: 'NGC 7026', kind: 'planetary', dist: 6000, ra: '21:06:18.48', dec: '+47:51:07.9', maj: 0.33, color: '#63c8c8' },
  { name: 'NGC 6751', ru: 'NGC 6751', kind: 'planetary', dist: 6400, ra: '19:05:55.55', dec: '-05:59:32.3', maj: 0.34, color: '#68c8c8' },
  { name: 'Monkey Head Nebula', ru: 'Туманность Голова обезьяны', kind: 'emission', dist: 6400, ra: '06:09:23.62', dec: '+20:39:34.5', maj: 40, size: 190, color: '#d0576a' },
  { name: 'NGC 6820', ru: 'NGC 6820', kind: 'emission', dist: 6500, ra: '19:42:28.02', dec: '+23:05:17.1', maj: 40, size: 170, color: '#c8556e' },
  { name: 'NGC 2899', ru: 'NGC 2899', kind: 'planetary', dist: 6500, ra: '09:27:02.96', dec: '-56:06:21.7', maj: 1.5, color: '#68c8c0' },
  { name: 'White Eyed Pea Nebula', ru: 'Туманность Белая горошина', kind: 'planetary', dist: 6500, ra: '17:45:00', dec: '-30:00:00', maj: 0.5, color: '#63c8d8', manual: true },
  { name: 'Crab Nebula', ru: 'Крабовидная туманность', kind: 'remnant', dist: 7000, ra: '05:34:31.9', dec: '+22:00:52', maj: 7, size: 150, color: '#d97a4a', manual: true, major: true },
  { name: 'NGC 1931', ru: 'NGC 1931', kind: 'emission', dist: 7000, ra: '05:31:25.35', dec: '+34:14:47.6', maj: 4.8, color: '#c85b7a' },
  { name: 'Eagle Nebula', ru: 'Туманность Орёл', kind: 'emission', dist: 7000, ra: '18:18:48.17', dec: '-13:48:26.0', maj: 120, size: 260, color: '#cf5f86', major: true },
  { name: 'Bubble Nebula', ru: 'Туманность Пузырь', kind: 'emission', dist: 7100, ra: '23:20:45.60', dec: '+61:12:44.5', maj: 15, size: 180, color: '#d8557f', ref: 'Bubble Sector PD-S b4-4', refCoords: { x: -6570.5, y: 29.84375, z: -2680.28125 }, major: true },
  { name: 'Heart and Soul Nebulae', ru: 'Туманности Сердце и Душа', kind: 'emission', dist: 7500, ra: '02:32:41.51', dec: '+61:27:24.8', maj: 60, size: 430, color: '#d94a63', ref: 'Heart Sector EB-X c1-12', refCoords: { x: -5150.90625, y: 98.625, z: -5326.6875 }, lobes: [{ x: -5303.78125, y: 130.34375, z: -5305.40625 }], major: true, note: 'Два больших облака H II в Кассиопее; на карте — самое крупное красное пятно периферии.' },
  { name: 'IC 4634', ru: 'IC 4634', kind: 'planetary', dist: 7500, ra: '17:01:33.59', dec: '-21:49:33.5', maj: 0.14, color: '#68c8c0' },
  { name: 'NGC 281', ru: 'NGC 281 (Пакман)', kind: 'emission', dist: 8000, ra: '00:52:25', dec: '+56:33:50', maj: 35, size: 170, color: '#c85b7a', manual: true },
  { name: 'NGC 5307', ru: 'NGC 5307', kind: 'planetary', dist: 8100, ra: '13:51:03.30', dec: '-51:12:20.8', maj: 0.21, color: '#63c8c8' },
  { name: 'NGC 2792', ru: 'NGC 2792', kind: 'planetary', dist: 8200, ra: '09:12:26.5', dec: '-42:25:47', maj: 0.6, color: '#63c8c8', manual: true },
  { name: 'NGC 5315', ru: 'NGC 5315', kind: 'planetary', dist: 8400, ra: '13:53:56.9', dec: '-66:30:51', maj: 0.2, color: '#68c8c0', manual: true },
  { name: 'Eta Carinae', ru: 'Эта Киля', kind: 'emission', dist: 9000, ra: '10:45:03.6', dec: '-59:41:04', maj: 2, size: 140, color: '#c85b6a', manual: true, major: true },
  { name: 'NGC 7538', ru: 'NGC 7538', kind: 'emission', dist: 9000, ra: '23:13:37.8', dec: '+61:30:13', maj: 8, color: '#c8557a', manual: true },
  { name: 'NGC 5979', ru: 'NGC 5979', kind: 'planetary', dist: 9000, ra: '15:47:41.1', dec: '-61:13:05', maj: 0.4, color: '#63c8c8', manual: true },
  { name: 'NGC 6886', ru: 'NGC 6886', kind: 'planetary', dist: 9000, ra: '20:12:42.8', dec: '+19:59:22', maj: 0.2, color: '#68c8c0', manual: true },
  { name: 'NGC 3211', ru: 'NGC 3211', kind: 'planetary', dist: 9100, ra: '10:17:50.4', dec: '-62:40:12', maj: 0.3, color: '#63c8c8', manual: true },
  { name: 'IC 5217', ru: 'IC 5217', kind: 'planetary', dist: 9400, ra: '22:19:46.2', dec: '+50:49:52', maj: 0.2, color: '#6fc8d8', manual: true },
  { name: 'NGC 1491', ru: 'NGC 1491', kind: 'emission', dist: 10000, ra: '04:03:15.8', dec: '+51:18:58', maj: 15, color: '#c8557a', manual: true },
  { name: 'NGC 6326', ru: 'NGC 6326', kind: 'planetary', dist: 11000, ra: '17:20:46.3', dec: '-51:45:14', maj: 0.3, color: '#63c8c0', manual: true },
  { name: 'IC 4191', ru: 'IC 4191', kind: 'planetary', dist: 14400, ra: '13:08:47.8', dec: '-67:38:38', maj: 0.2, color: '#63c8c0', manual: true },
  { name: 'Banana Nebula NGC 3199', ru: 'Туманность Банан', kind: 'emission', dist: 15000, ra: '10:17:24.43', dec: '-57:55:20.0', maj: 20, size: 220, color: '#c8556e', shape: 'arc' },
  { name: 'NGC 2467', ru: 'Туманность Череп и кости', kind: 'emission', dist: 15000, ra: '07:52:29.1', dec: '-26:23:40', maj: 15, size: 200, color: '#c85b8a', manual: true },
  { name: 'IC 2621', ru: 'IC 2621', kind: 'planetary', dist: 15500, ra: '11:00:09.8', dec: '-65:14:56', maj: 0.2, color: '#63c8c8', manual: true },
  { name: 'Skull Nebula', ru: 'Туманность Череп', kind: 'planetary', dist: 1600, ra: '00:47:03.3', dec: '-11:52:19', maj: 3.8, color: '#5fc8c8', manual: true },
  { name: "Cat's Eye Nebula", ru: 'Туманность Кошачий глаз', kind: 'planetary', dist: 3270, ra: '17:58:33.39', dec: '+66:37:59.5', maj: 0.9, color: '#6fd0d8' },
  { name: 'Saturn Nebula', ru: 'Туманность Сатурн', kind: 'planetary', dist: 5200, ra: '21:04:10.79', dec: '-11:21:47.7', maj: 0.7, color: '#68c8d0' },
  { name: 'NGC 6210', ru: 'NGC 6210', kind: 'planetary', dist: 5300, ra: '16:44:29.5', dec: '+23:47:59', maj: 0.3, color: '#68c8c0', manual: true },
  { name: 'Blue Snowball Nebula', ru: 'Голубой снежок', kind: 'planetary', dist: 5500, ra: '23:25:53.90', dec: '+42:32:05.8', maj: 0.28, color: '#5fa8e8' },
  { name: 'G2 dustcloud', ru: 'Пылевое облако G2', kind: 'dark', dist: 27900, ra: '17:45:40', dec: '-29:00:28', maj: 20, color: '#0e1522', manual: true } ];

/* ── Расчёт ─────────────────────────────────────────────────────────────── */

const KIND_MIN = { emission: 120, reflection: 90, cluster: 150, dark: 90, planetary: 60, remnant: 100 };
const KIND_MAX = { emission: 900, reflection: 500, cluster: 900, dark: 900, planetary: 170, remnant: 500 };

/** Видимый размер облака на карте: угловой размер объекта, растянутый для свечения. */
function visibleSize(entry) {
  const physical = entry.maj ? (entry.maj / 60) * (Math.PI / 180) * entry.dist : 0;
  const gain = entry.kind === 'planetary' ? 3 : 2.2;
  const raw = entry.size ?? physical * gain + 40;
  const min = KIND_MIN[entry.kind] ?? 90;
  const max = KIND_MAX[entry.kind] ?? 900;
  return Math.round(Math.min(max, Math.max(min, raw)));
}

const built = NEBULAE.map((entry) => {
  const raDeg = raHoursToDeg(entry.ra);
  const decDeg = parseSexagesimal(entry.dec);
  const coords = eliteCoords(raDeg, decDeg, entry.dist);
  // Система внутри туманности — самый точный источник позиции: облако в игре
  // всегда накрывает её. Астрономический расчёт остаётся fallback'ом, а его
  // результат хранится рядом для проверки.
  const point = entry.refCoords ?? coords;
  return {
    ...entry,
    raDeg,
    decDeg,
    x: Number(point.x.toFixed(2)),
    y: Number(point.y.toFixed(2)),
    z: Number(point.z.toFixed(2)),
    astroX: Number(coords.x.toFixed(2)),
    astroY: Number(coords.y.toFixed(2)),
    astroZ: Number(coords.z.toFixed(2)),
    l: Number(coords.l.toFixed(2)),
    b: Number(coords.b.toFixed(2)),
    source: entry.refCoords ? 'game-system' : 'astro',
    distance: entry.refCoords ? Number(Math.hypot(point.x, point.y, point.z).toFixed(1)) : entry.dist,
    size: visibleSize(entry),
  };
});

/* ── Проверка: координаты известных систем игры ─────────────────────────── */

const CHECKS = [
  ['Maia', 'Pleiades Nebula', { x: -81.78125, y: -149.4375, z: -343.375 }],
  ['HIP 23759', 'Witch Head Nebula', { x: 359.84375, y: -385.53125, z: -718.375 }],
  ['HD 36917', 'Orion Nebula', { x: 593.3125, y: -433.53125, z: -1065.03125 }],
  ['Flaming Star Sector GW-W c1-4', 'IC 405 - Flaming Star Nebula', { x: -233.5, y: -67.1875, z: -1681.3125 }],
  ['California Sector LX-T b3-0', 'California Nebula', { x: -337.90625, y: -211.9375, z: -927.03125 }],
  ['Heart Sector EB-X c1-12', 'Heart and Soul Nebulae', { x: -5150.90625, y: 98.625, z: -5326.6875 }],
  ['GCRV 2334', 'NGC 1501', { x: -2071.59375, y: 413.75, z: -2915.03125 }],
  ['V380 Orionis', 'NGC 1999', { x: 549.34375, y: -374.53125, z: -926.59375 }],
  ['Veil West Sector DL-Y d68', 'Veil Nebula West', { x: -1398.25, y: -193.5625, z: 418.90625 }],
  ['Bubble Sector PD-S b4-4', 'Bubble Nebula', { x: -6570.5, y: 29.84375, z: -2680.28125 }],
  ['BD-12 1172', 'Spirograph Nebula', { x: 577.875, y: -452.6875, z: -819.25 }],
];

function verify() {
  const byName = new Map(built.map((n) => [n.name, n]));
  console.log('\nСверка с реальными системами игры (EDSM):');
  let worstAstro = 0;
  let worstSystem = 0;
  for (const [system, nebulaName, expected] of CHECKS) {
    if (!expected || !nebulaName) continue;
    const n = byName.get(nebulaName);
    if (!n) { console.log(`  ${system}: нет записи «${nebulaName}»`); continue; }
    const errSystem = Math.hypot(n.x - expected.x, n.y - expected.y, n.z - expected.z);
    const errAstro = Math.hypot(n.astroX - expected.x, n.astroY - expected.y, n.astroZ - expected.z);
    worstSystem = Math.max(worstSystem, errSystem);
    worstAstro = Math.max(worstAstro, errAstro);
    console.log(`  ${nebulaName.padEnd(30)} итог ${errSystem.toFixed(0).padStart(5)} | расчёт по каталогу ${errAstro.toFixed(0).padStart(5)} св. лет`);
  }
  console.log(`  Худшее отклонение: по системе ${worstSystem.toFixed(0)}, по каталогу ${worstAstro.toFixed(0)} св. лет\n`);
}

/* ── Генерация TS ───────────────────────────────────────────────────────── */

const KIND_LABELS = {
  emission: 'Эмиссионная туманность',
  reflection: 'Отражательная туманность',
  cluster: 'Скопление с туманностью',
  dark: 'Тёмная туманность',
  planetary: 'Планетарная туманность',
  remnant: 'Остаток сверхновой',
};

function ts() {
  const rows = built
    .slice()
    .sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name))
    .map((n) => {
      const parts = [
        `name: ${JSON.stringify(n.name)}`,
        `ru: ${JSON.stringify(n.ru)}`,
        `kind: '${n.kind}'`,
        `x: ${n.x}`,
        `y: ${n.y}`,
        `z: ${n.z}`,
        `distance: ${n.distance}`,
        `size: ${n.size}`,
        `color: '${n.color}'`,
      ];
      if (n.shape) parts.push(`shape: '${n.shape}'`);
      if (n.ref) parts.push(`refSystem: ${JSON.stringify(n.ref)}`);
      if (n.lobes) parts.push(`lobes: [${n.lobes.map((l) => `{ x: ${l.x}, y: ${l.y}, z: ${l.z} }`).join(', ')}]`);
      parts.push(`positionSource: '${n.source}'`);
      if (n.major) parts.push('major: true');
      if (n.sharp) parts.push('sharp: true');
      if (n.note) parts.push(`note: ${JSON.stringify(n.note)}`);
      // RA/Dec храним в градусах — по ним можно перепроверить координаты.
      parts.push(`ra: ${n.raDeg.toFixed(5)}`, `dec: ${n.decDeg.toFixed(5)}`);
      parts.push(`astro: { x: ${n.astroX}, y: ${n.astroY}, z: ${n.astroZ} }`);
      if (n.manual) parts.push('approx: true');
      return `  {\n    ${parts.join(',\n    ')},\n  },`;
    })
    .join('\n');

  return `/**
 * Каталог настоящих туманностей Elite Dangerous для 3D-карты галактики.
 *
 * ФАЙЛ СГЕНЕРИРОВАН: \`node scripts/build-nebula-catalog.mjs\`.
 * Правьте таблицу в скрипте, а не здесь.
 *
 * Как получаются координаты: игра ставит настоящую туманность в её реальное
 * направление на небе (RA/Dec каталога OpenNGC) и только расстояние от Sol
 * берёт игровое (списки «Nebula» вики и темы Frontier). Перевод из
 * экваториальных координат в галактические и далее в оси Elite
 * (x — к центру Галактики, y — вверх, z — к Sol) даёт позицию, которая
 * совпадает с системами игры внутри туманностей с точностью до единиц
 * св. лет (см. \`--verify\` в скрипте).
 *
 * size — видимый диаметр облака на карте галактики в св. годах: угловой
 * размер объекта, растянутый на свечение, с ограничениями по типу.
 */

export type NebulaKind = 'emission' | 'reflection' | 'cluster' | 'dark' | 'planetary' | 'remnant';

/** Форма облака на карте. cloud — по умолчанию, остальные подчёркивают облик объекта. */
export type NebulaShape = 'cloud' | 'arc' | 'filament' | 'elongated' | 'silhouette';

export interface GalaxyNebula {
  /** Название как в игре. */
  name: string;
  /** Русская подпись для интерфейса. */
  ru: string;
  kind: NebulaKind;
  /** Координаты Elite Dangerous. */
  x: number;
  y: number;
  z: number;
  /** Расстояние от Sol (св. лет) — игровое значение. */
  distance: number;
  /** Видимый диаметр облака на карте (св. лет). */
  size: number;
  color: string;
  shape?: NebulaShape;
  /** Реальная система внутри туманности: можно прыгнуть и посмотреть вблизи. */
  refSystem?: string;
  /** Подписывать на карте галактики. */
  major?: boolean;
  /** Резкие края — для объектов вроде Конской головы. */
  sharp?: boolean;
  /** Дополнительные центры облака (двухлепестковые туманности вроде Сердца и Души). */
  lobes?: Array<{ x: number; y: number; z: number }>;
  /** Откуда взята позиция: система из игры или расчёт по каталогу. */
  positionSource: 'game-system' | 'astro';
  note?: string;
  /** Прямое восхождение и склонение (J2000), градусы — источник координат. */
  ra: number;
  dec: number;
  /** Координаты приблизительные (объекта нет в OpenNGC). */
  approx?: boolean;
  /** Позиция по астрономическому расчёту — для сравнения с системой из игры. */
  astro: { x: number; y: number; z: number };
}

export const NEBULA_KIND_LABELS: Record<NebulaKind, string> = ${JSON.stringify(KIND_LABELS, null, 2)};

export const GALAXY_NEBULAE: GalaxyNebula[] = [
${rows}
];

/** Туманности, которые подписываются на карте (иначе подписи закрыли бы весь диск). */
export const MAJOR_NEBULAE = GALAXY_NEBULAE.filter((nebula) => nebula.major);

export function nebulaByName(name: string): GalaxyNebula | undefined {
  return GALAXY_NEBULAE.find((nebula) => nebula.name === name);
}

/** Расстояние между двумя точками в св. годах. */
export function nebulaDistanceTo(
  nebula: GalaxyNebula,
  point: { x: number; y: number; z: number },
): number {
  return Math.hypot(nebula.x - point.x, nebula.y - point.y, nebula.z - point.z);
}
`;
}

if (process.argv.includes('--verify')) verify();

fs.writeFileSync(OUT, ts());
const kinds = built.reduce((acc, n) => ({ ...acc, [n.kind]: (acc[n.kind] || 0) + 1 }), {});
console.log(`Записано ${built.length} туманностей → ${path.relative(ROOT, OUT)}`);
console.log('По типам:', kinds);
if (!process.argv.includes('--verify')) verify();
