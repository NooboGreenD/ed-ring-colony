-- ══════════════════════════════════════════════════════════════════════════
-- Живые данные EDDN (web 2.23.0, по желанию администратора).
--
-- Слушатель (`src/lib/eddn/listener.ts`) подписывается на реле EDDN и отдаёт
-- прыжки и входы в игру тому же разбору, что журналы Colonial Helper и сайта:
-- владелец системы PowerPlay (ControllingPower — его нет в дампе EDSM),
-- состояние и фракции — одним наблюдением, источник `eddn`.
--
-- Здесь одна строка: включён ли слушатель (решает администратор в
-- «Игровые данные → PowerPlay»; флаг переживает перезапуск сайта), его
-- состояние, счётчики и журнал — для админки. Пишет только сервер.
--
-- Миграция идемпотентна.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.eddn_listener_state (
  id            SMALLINT PRIMARY KEY DEFAULT 1,
  -- Включён администратором: процесс сайта поднимает слушатель сам
  -- (задача eddn-listener раз в 5 минут, открытие слоя PowerPlay, админка).
  enabled       BOOLEAN NOT NULL DEFAULT false,
  enabled_at    TIMESTAMPTZ,
  enabled_by    UUID,
  -- off | connecting | connected | waiting — последнее, что сообщил процесс.
  status        TEXT NOT NULL DEFAULT 'off',
  relay         TEXT,
  -- Счётчики текущего запуска: сообщения, наблюдения, записи в слои, переподключения.
  stats         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Журнал: подключения, «тишина» реле, ошибки записи.
  log           JSONB NOT NULL DEFAULT '[]'::jsonb,
  error         TEXT,
  -- Когда процесс последний раз писал состояние (живой ли слушатель).
  heartbeat_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT eddn_listener_state_singleton CHECK (id = 1),
  CONSTRAINT eddn_listener_state_status_check
    CHECK (status IN ('off', 'connecting', 'connected', 'waiting'))
);

INSERT INTO public.eddn_listener_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.eddn_listener_state ENABLE ROW LEVEL SECURITY;
-- Политик нет: читает и пишет только сервер (service_role).
REVOKE ALL ON public.eddn_listener_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.eddn_listener_state TO service_role;

COMMENT ON TABLE public.eddn_listener_state IS
  'Слушатель живых данных EDDN: включён ли (админка, PowerPlay), состояние, счётчики и журнал. Наблюдения уходят в слои PowerPlay и фракций с источником eddn.';

NOTIFY pgrst, 'reload schema';
