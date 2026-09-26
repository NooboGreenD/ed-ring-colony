-- Сохраняем большую полуось из события Scan для орбитальной сверки в Архитекторе.
ALTER TABLE public.system_scans
  ADD COLUMN IF NOT EXISTS semi_major_axis_ls DOUBLE PRECISION;
