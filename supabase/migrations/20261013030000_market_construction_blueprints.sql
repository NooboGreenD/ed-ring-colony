-- Pin a search to its selected construction recipe instead of the generic list.
ALTER TABLE public.market_search_jobs ADD COLUMN IF NOT EXISTS build_type TEXT;
COMMENT ON COLUMN public.market_search_jobs.build_type IS 'Construction blueprint key; null/all uses the complete construction commodity list.';

-- Commander purchase price, distinct from legacy sell_price cache values.
ALTER TABLE public.market_search_cache ADD COLUMN IF NOT EXISTS buy_price INTEGER;
