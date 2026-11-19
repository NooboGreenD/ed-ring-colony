-- ============================================================================
-- 20261118010000_squadron_transfer_fix.sql
-- Исправление автовступления: при переходе пилота в новую эскадрилью
-- стараяメンバーство освобождается, а не блокирует вступление.
--
-- Проблема: apply_pilot_squadron() при p_join = true отказывает с
-- `other_squadron`, если у пилота уже есть запись в squadron_members.
-- Из-за этого пилот, перешедший в другую эскадрилью в игре, остаётся
-- «прикованным» к первой эскадрилье сайта, в которую когда-либо вступил.
-- Даже если он там не лидер — в новой эскадрилью его не добавить.
--
-- Решение: при автовступлении (p_join = true) предварительно удаляем
-- староеメンバーство пилота, чтобы он мог перейти в новую эскадрилью.
-- Идемпотентна: CREATE OR REPLACE — безопасно применять повторно.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_pilot_squadron(
  p_user            UUID,
  p_game_id         BIGINT,
  p_name            TEXT,
  p_tag             TEXT DEFAULT NULL,
  p_rank            INTEGER DEFAULT NULL,
  p_rank_name       TEXT DEFAULT NULL,
  p_at              TIMESTAMPTZ DEFAULT now(),
  p_source          TEXT DEFAULT 'helper',
  p_join            BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name        TEXT := btrim(coalesce(p_name, ''));
  v_tag         TEXT := upper(regexp_replace(coalesce(p_tag, ''), '[^A-Za-z0-9]', '', 'g'));
  v_source      TEXT := CASE WHEN p_source IN ('helper', 'web', 'manual') THEN p_source ELSE 'helper' END;
  v_at          TIMESTAMPTZ := coalesce(p_at, now());
  v_prev_at     TIMESTAMPTZ;
  v_squadron_id BIGINT;
  v_squadron_name TEXT;
  v_found_by    TEXT;
  v_rank_id     BIGINT;
  v_rank_name   TEXT;
  v_is_member   BOOLEAN := false;
  v_joined      BOOLEAN := false;
  v_reason      TEXT;
  v_size        INTEGER;
  v_limit       INTEGER;
  v_game_rank   INTEGER := CASE WHEN p_rank IS NULL OR p_rank < 0 THEN NULL ELSE LEAST(p_rank, 99) END;
  v_target_rank BIGINT;
  v_rank_count  INTEGER;
  v_created     BOOLEAN := false;
  v_owner       UUID;
  v_new_tag     TEXT;
  v_suffix      INTEGER := 1;
BEGIN
  IF p_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_required');
  END IF;

  -- Профиль есть у каждого аккаунта; если строки нет (старая база), создать её
  -- здесь нельзя: id ссылается на auth.users, а функция — service_role.
  SELECT game_squadron_at INTO v_prev_at
    FROM public.profiles
   WHERE id = p_user;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'profile_missing');
  END IF;

  -- Пере-импорт истории: старый SquadronStartup не должен возвращать пилота в
  -- прежнюю эскадрилью после того, как он вступил в новую.
  IF v_prev_at IS NOT NULL AND v_at < v_prev_at THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'stale', 'at', v_prev_at);
  END IF;

  IF v_game_rank IS NOT NULL AND (p_rank_name IS NULL OR btrim(p_rank_name) = '') AND v_game_rank > 8 THEN
    v_game_rank := NULL;
  END IF;

  -- ── Поиск эскадрильи сайта ───────────────────────────────────────────────
  IF p_game_id IS NOT NULL AND p_game_id > 0 THEN
    SELECT sq.id, sq.name INTO v_squadron_id, v_squadron_name
      FROM public.squadrons AS sq
     WHERE sq.game_squadron_id = p_game_id
     LIMIT 1;
    IF FOUND THEN
      v_found_by := 'game_id';
    END IF;
  END IF;

  IF v_squadron_id IS NULL AND v_name <> '' THEN
    SELECT sq.id, sq.name INTO v_squadron_id, v_squadron_name
      FROM public.squadrons AS sq
     WHERE lower(btrim(sq.name)) = lower(v_name)
     LIMIT 1;
    IF FOUND THEN
      v_found_by := 'name';
    END IF;
  END IF;

  -- Тег: журнал иногда приносит `SquadronTag`, а название на сайте могло быть
  -- переведено или дополнено. Совпадение по тегу не даёт создавать дубль.
  IF v_squadron_id IS NULL AND v_tag <> '' THEN
    SELECT sq.id, sq.name INTO v_squadron_id, v_squadron_name
      FROM public.squadrons AS sq
     WHERE upper(btrim(coalesce(sq.tag, ''))) = v_tag
     LIMIT 1;
    IF FOUND THEN
      v_found_by := 'tag';
    END IF;
  END IF;

  -- ── Создание эскадрильи, которой на сайте ещё нет ────────────────────────
  IF v_squadron_id IS NULL AND v_name <> ''
     AND coalesce(p_join, true)
     AND NOT EXISTS (SELECT 1 FROM public.squadron_members AS sm WHERE sm.user_id = p_user) THEN
    BEGIN
      SELECT id INTO v_owner FROM public.profiles WHERE id = p_user;
      IF v_owner IS NOT NULL THEN
        v_new_tag := CASE
          WHEN v_tag <> '' THEN left(v_tag, 10)
          ELSE left(upper(regexp_replace(v_name, '[^A-Za-z0-9]', '', 'g')), 10)
        END;
        IF v_new_tag = '' THEN
          v_new_tag := 'SQDN';
        END IF;

        LOOP
          BEGIN
            INSERT INTO public.squadrons (name, tag, created_by, member_limit,
                                          status, is_open_recruitment,
                                          game_squadron_id, game_squadron_at,
                                          game_squadron_source)
            VALUES (left(v_name, 100), v_new_tag, v_owner, 600,
                    'active', true,
                    p_game_id, v_at, 'journal')
            RETURNING id INTO v_squadron_id;
            v_created := true;
            v_found_by := 'created';
            v_squadron_name := left(v_name, 100);
            EXIT;
          EXCEPTION
            WHEN unique_violation THEN
              SELECT sq.id, sq.name INTO v_squadron_id, v_squadron_name
                FROM public.squadrons AS sq
               WHERE sq.game_squadron_id = p_game_id
               LIMIT 1;
              IF v_squadron_id IS NOT NULL THEN
                v_found_by := 'game_id';
                EXIT;
              END IF;
              v_suffix := v_suffix + 1;
              IF v_suffix > 5 THEN
                v_squadron_id := NULL;
                EXIT;
              END IF;
              v_new_tag := left(regexp_replace(v_new_tag, '[0-9]+$', ''), 8) || v_suffix::text;
            WHEN undefined_column THEN
              BEGIN
                INSERT INTO public.squadrons (name, tag, created_by, game_squadron_id,
                                              game_squadron_at, game_squadron_source)
                VALUES (left(v_name, 100), v_new_tag, v_owner, p_game_id,
                        v_at, 'journal')
                RETURNING id INTO v_squadron_id;
                v_created := true;
                v_found_by := 'created';
                v_squadron_name := left(v_name, 100);
              EXCEPTION WHEN OTHERS THEN
                v_squadron_id := NULL;
              END;
              EXIT;
            WHEN OTHERS THEN
              v_squadron_id := NULL;
              EXIT;
          END;
        END LOOP;
      END IF;
    END;
  END IF;

  -- Связь выучивается один раз.
  IF v_squadron_id IS NOT NULL AND p_game_id IS NOT NULL AND p_game_id > 0 THEN
    UPDATE public.squadrons AS sq
       SET game_squadron_id = p_game_id,
           game_squadron_at = greatest(coalesce(sq.game_squadron_at, v_at), v_at),
           game_squadron_source = coalesce(sq.game_squadron_source,
               CASE WHEN v_found_by = 'game_id' THEN 'game_id' ELSE 'name' END)
     WHERE sq.id = v_squadron_id
       AND (sq.game_squadron_id IS NULL OR sq.game_squadron_id = p_game_id);
  END IF;

  -- ── Профиль ──────────────────────────────────────────────────────────────
  UPDATE public.profiles AS p
     SET game_squadron_id = coalesce(p_game_id, p.game_squadron_id),
         game_squadron_name = CASE WHEN v_name <> '' THEN left(v_name, 120) ELSE p.game_squadron_name END,
         game_squadron_tag = CASE WHEN v_tag <> '' THEN left(v_tag, 8) ELSE p.game_squadron_tag END,
         game_squadron_rank = coalesce(v_game_rank, p.game_squadron_rank),
         game_squadron_rank_name = CASE
             WHEN p_rank_name IS NOT NULL AND btrim(p_rank_name) <> '' THEN left(btrim(p_rank_name), 80)
             ELSE p.game_squadron_rank_name END,
         game_squadron_at = greatest(coalesce(p.game_squadron_at, v_at), v_at),
         game_squadron_source = v_source,
         game_squadron_site_id = coalesce(v_squadron_id, p.game_squadron_site_id),
         updated_at = now()
   WHERE p.id = p_user;

  -- ── Автовступление в состав ──────────────────────────────────────────────
  IF v_squadron_id IS NOT NULL THEN
    SELECT true, sm.rank_id INTO v_is_member, v_target_rank
      FROM public.squadron_members AS sm
     WHERE sm.squadron_id = v_squadron_id AND sm.user_id = p_user
     LIMIT 1;
    v_is_member := coalesce(v_is_member, false);

    IF NOT v_is_member AND coalesce(p_join, true) THEN
      SELECT coalesce(sq.member_limit, 500), (
          SELECT count(*)::integer FROM public.squadron_members AS sm
           WHERE sm.squadron_id = v_squadron_id)
        INTO v_limit, v_size
        FROM public.squadrons AS sq
       WHERE sq.id = v_squadron_id;

      -- Пилот не может быть в двух эскадрильях одновременно. При переходе
      -- в новую освобождаем старое место вместо отказа.
      IF EXISTS (SELECT 1 FROM public.squadron_members AS sm WHERE sm.user_id = p_user) THEN
        DELETE FROM public.squadron_members WHERE user_id = p_user;
        v_reason := 'transferred';
      ELSIF v_size >= v_limit THEN
        v_reason := 'full';
      ELSE
        IF p_rank_name IS NOT NULL AND btrim(p_rank_name) <> '' THEN
          SELECT r.id, r.name INTO v_rank_id, v_rank_name
            FROM public.squadron_ranks AS r
           WHERE r.squadron_id = v_squadron_id
             AND NOT (r.can_edit_squadron OR r.can_manage_members
                      OR r.can_manage_ranks OR r.can_manage_projects)
             AND lower(btrim(r.name)) = lower(btrim(p_rank_name))
           ORDER BY r.sort_order DESC, r.id
           LIMIT 1;
        END IF;

        IF v_rank_id IS NULL THEN
          SELECT count(*)::integer INTO v_rank_count
            FROM public.squadron_ranks AS r
           WHERE r.squadron_id = v_squadron_id
             AND NOT (r.can_edit_squadron OR r.can_manage_members
                      OR r.can_manage_ranks OR r.can_manage_projects);

          IF v_rank_count > 0 THEN
            SELECT r.id, r.name INTO v_rank_id, v_rank_name
              FROM public.squadron_ranks AS r
             WHERE r.squadron_id = v_squadron_id
               AND NOT (r.can_edit_squadron OR r.can_manage_members
                        OR r.can_manage_ranks OR r.can_manage_projects)
             ORDER BY r.sort_order DESC, r.id
             OFFSET LEAST(GREATEST(coalesce(v_game_rank, 0), 0), v_rank_count - 1)
             LIMIT 1;
          END IF;
        END IF;

        INSERT INTO public.squadron_members
          (squadron_id, user_id, rank_id, game_rank, game_rank_name,
           game_synced_at, joined_at, joined_via, created_at)
        VALUES
          (v_squadron_id, p_user, v_rank_id, v_game_rank, left(coalesce(p_rank_name, ''), 80),
           v_at, v_at, 'game', now())
        ON CONFLICT (squadron_id, user_id) DO NOTHING;
        v_joined := FOUND;
      END IF;
    ELSIF v_is_member THEN
      IF v_created THEN
        v_joined := true;
      END IF;
      UPDATE public.squadron_members AS sm
         SET game_rank = coalesce(v_game_rank, sm.game_rank),
             game_rank_name = CASE
                 WHEN p_rank_name IS NOT NULL AND btrim(p_rank_name) <> ''
                   THEN left(btrim(p_rank_name), 80)
                 ELSE sm.game_rank_name END,
             game_synced_at = greatest(coalesce(sm.game_synced_at, v_at), v_at)
       WHERE sm.squadron_id = v_squadron_id AND sm.user_id = p_user;
    ELSE
      v_reason := 'join_disabled';
    END IF;
  ELSE
    v_reason := coalesce(v_reason, 'squadron_not_found');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'gameSquadronId', p_game_id,
    'gameSquadronName', nullif(v_name, ''),
    'gameRank', v_game_rank,
    'squadronId', v_squadron_id,
    'squadronName', v_squadron_name,
    'foundBy', v_found_by,
    'member', v_is_member,
    'joined', v_joined,
    'created', v_created,
    'rankId', v_rank_id,
    'rankName', v_rank_name,
    'reason', v_reason,
    'at', v_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_pilot_squadron(UUID, BIGINT, TEXT, TEXT, INTEGER, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_pilot_squadron(UUID, BIGINT, TEXT, TEXT, INTEGER, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN)
  TO service_role;

COMMENT ON FUNCTION public.apply_pilot_squadron(UUID, BIGINT, TEXT, TEXT, INTEGER, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN) IS
  'Эскадрилья из журнала → профиль, связь с эскадрильей сайта и автовступление в состав. При переходе в новую эскадрилью старое членство освобождается (transferred).';
