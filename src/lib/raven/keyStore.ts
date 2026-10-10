/** Расшифрованный RCC-ключ пользователя — только для серверных маршрутов. */
import { createServiceClient } from '@/lib/supabaseServer';
import { decryptRavenKey } from '@/lib/raven/keyVault';

export async function loadRavenKey(userId: string): Promise<{ key: string | null; cmdrName: string | null; error?: string }> {
  const { data, error } = await createServiceClient()
    .from('raven_keys')
    .select('key_cipher, cmdr_name')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { key: null, cmdrName: null, error: error.message };
  if (!data) return { key: null, cmdrName: null };
  return { key: decryptRavenKey(data.key_cipher, process.env.RAVEN_KEY_SECRET || ''), cmdrName: data.cmdr_name ?? null };
}
