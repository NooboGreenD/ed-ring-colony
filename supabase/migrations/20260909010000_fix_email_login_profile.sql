-- Исправление проблемы с загрузкой профиля при входе по email
-- Триггер теперь не создаёт профиль с пустым cmdr_name

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_cmdr_name text;
BEGIN
  -- Получаем cmdr_name из метаданных, только если оно не пустое
  v_cmdr_name := NULLIF(TRIM(NEW.raw_user_meta_data->>'cmdr_name'), '');
  
  INSERT INTO public.profiles (id, email, cmdr_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    v_cmdr_name,
    'user'
  )
  ON CONFLICT (id) DO NOTHING;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
