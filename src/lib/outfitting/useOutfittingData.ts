'use client';

/**
 * Загрузка справочника верфи в браузере.
 *
 * Справочник — статический файл (~460 КБ), поэтому он не должен попадать в
 * бандл страницы: качаем один раз и держим в модульном кеше, чтобы переходы
 * между вкладками верфи не дёргали сеть.
 */

import { useEffect, useState } from 'react';
import type { OutfittingData } from './types';

const URL = '/data/outfitting.json';

let cache: OutfittingData | null = null;
let pending: Promise<OutfittingData> | null = null;

export function loadOutfittingData(): Promise<OutfittingData> {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = fetch(URL, { cache: 'force-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`Справочник верфи недоступен (${response.status})`);
        return response.json() as Promise<OutfittingData>;
      })
      .then((data) => {
        cache = data;
        return data;
      })
      .catch((error) => {
        pending = null;
        throw error;
      });
  }
  return pending;
}

export function useOutfittingData(): { data: OutfittingData | null; error: string } {
  const [data, setData] = useState<OutfittingData | null>(cache);
  const [error, setError] = useState('');

  useEffect(() => {
    if (cache) {
      setData(cache);
      return undefined;
    }
    let cancelled = false;
    loadOutfittingData()
      .then((loaded) => {
        if (!cancelled) setData(loaded);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить справочник');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, error };
}
