-- ═══════════════════════════════════════════════════════════════
-- Migration: сигналы тел — не только биология
-- ═══════════════════════════════════════════════════════════════
--
-- `system_scans` умел считать лишь биологические сигналы. Игра сообщает
-- в `FSSBodySignals`/`SAASignalsFound` и остальные: геологические точки
-- (материалы), следы людей (чужое присутствие рядом со стройкой),
-- сигналы стражей и таргоидов. Архитектору системы они нужны на карточке
-- тела и на 3D-карте, поэтому храним их рядом с биологией.
--
-- Колонки добавляются отдельно от `bio_signals_count`, а не заменяют его:
-- на него ссылаются уже записанные строки, импорт EDSM и приложение-помощник.

ALTER TABLE public.system_scans
  ADD COLUMN IF NOT EXISTS geo_signals_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS human_signals_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS thargoid_signals_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS guardian_signals_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_signals_count INTEGER DEFAULT 0,
  -- Сырой список сигналов события: тип + количество. Хранится «как есть»,
  -- чтобы новые типы сигналов не требовали новой миграции.
  ADD COLUMN IF NOT EXISTS signals JSONB DEFAULT '[]'::jsonb;

-- Выборка «где есть сигналы» по системе: карточки тел в архитекторе и
-- фильтр «есть сигналы» на 3D-карте ходят именно так.
CREATE INDEX IF NOT EXISTS idx_system_scans_signals
  ON public.system_scans (system_name)
  WHERE bio_signals_count > 0
     OR geo_signals_count > 0
     OR human_signals_count > 0
     OR thargoid_signals_count > 0
     OR guardian_signals_count > 0
     OR other_signals_count > 0;

COMMENT ON COLUMN public.system_scans.geo_signals_count IS 'Геологические сигналы тела (FSSBodySignals/SAASignalsFound)';
COMMENT ON COLUMN public.system_scans.human_signals_count IS 'Сигналы человеческого присутствия на теле';
COMMENT ON COLUMN public.system_scans.thargoid_signals_count IS 'Сигналы таргоидов на теле';
COMMENT ON COLUMN public.system_scans.guardian_signals_count IS 'Сигналы стражей на теле';
COMMENT ON COLUMN public.system_scans.other_signals_count IS 'Прочие сигналы, которые игра не отнесла к известным типам';
COMMENT ON COLUMN public.system_scans.signals IS 'Сырой список сигналов: [{"type": "...", "count": N}]';
