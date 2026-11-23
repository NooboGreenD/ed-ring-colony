-- S09: authenticated API checks the perk; only the service writes metadata
-- and Storage objects. Do not grant users write access to the official bucket.
-- Applied atomically by deploy/update-project.sh (--single-transaction).
REVOKE INSERT, UPDATE, DELETE ON public.user_ship_photos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_ship_photos TO anon, authenticated;
GRANT ALL ON public.user_ship_photos TO service_role;
DROP POLICY IF EXISTS "Users can insert their own ship photos" ON public.user_ship_photos;
DROP POLICY IF EXISTS "Users can update their own ship photos" ON public.user_ship_photos;
DROP POLICY IF EXISTS "Users can delete their own ship photos" ON public.user_ship_photos;

-- The lock covers both quota and primary flag changes. No cleanup/backfill of
-- existing rows: an over-quota legacy gallery remains readable/deletable.
CREATE OR REPLACE FUNCTION public.enforce_user_ship_photo_quota()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text || '/' || NEW.ship_id, 0));
  IF (SELECT count(*) FROM public.user_ship_photos p
      WHERE p.user_id = NEW.user_id AND p.ship_id = NEW.ship_id) >= 5 THEN
    RAISE EXCEPTION 'Ship photo quota exceeded' USING ERRCODE = '23514';
  END IF;
  IF NEW.is_primary THEN
    UPDATE public.user_ship_photos SET is_primary = false
      WHERE user_id = NEW.user_id AND ship_id = NEW.ship_id AND is_primary;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS enforce_user_ship_photo_quota ON public.user_ship_photos;
CREATE TRIGGER enforce_user_ship_photo_quota BEFORE INSERT ON public.user_ship_photos
  FOR EACH ROW EXECUTE FUNCTION public.enforce_user_ship_photo_quota();
NOTIFY pgrst, 'reload schema';
