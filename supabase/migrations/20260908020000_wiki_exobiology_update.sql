-- Заметка вместо миграции: обновление статей по экзобиологии (18 штук) делалось
-- через Management API, в SQL-виде контент лежит в
-- 20260908010000_wiki_exobiology.sql.
--
-- Раньше файл был просто набором комментариев: psql считает такой скрипт
-- успешно выполненным, миграция отмечалась применённой и ничего не делала — это
-- создавало иллюзию, что статья накатывается автоматически. Оставляем версию в
-- истории (как 20260903170000_fix_squadron_friends.sql), но с явным NOTICE.
DO $$
BEGIN
  RAISE NOTICE 'Exobiology articles are seeded by 20260908010000_wiki_exobiology.sql (content was uploaded via the Management API).';
END $$;
