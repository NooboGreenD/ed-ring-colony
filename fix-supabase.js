/*
 * Local, one-off profile repair utility.
 *
 * Run only in a trusted shell with explicit environment variables, for example:
 *   node --env-file=.env.local fix-supabase.js
 *
 * Never paste credentials into this file or commit them to the repository.
 */
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  console.error('Use a local ignored environment file or export both values before running this maintenance utility.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: { transport: ws },
});

async function fixDatabase() {
  console.log('🔍 Анализ ситуации...');

  const { data: users, error: usersError } = await supabase.auth.admin.listUsers();
  if (usersError) {
    console.error('❌ Ошибка получения пользователей:', usersError.message);
    return;
  }

  console.log(`✅ Найдено пользователей: ${users.users.length}`);

  let fixedCount = 0;
  let createdCount = 0;
  let missingProfileCount = 0;

  for (const user of users.users) {
    const cmdrNameFromMeta = user.user_metadata?.cmdr_name;
    const cmdrNameFromEmail = user.email ? user.email.split('@')[0] : 'UnknownCommander';
    const finalCmdrName = cmdrNameFromMeta || cmdrNameFromEmail;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, cmdr_name')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError) {
      console.error(`⚠️ Ошибка проверки профиля для ${user.id}: ${profileError.message}`);
      continue;
    }

    if (!profile) {
      missingProfileCount += 1;
      const { error: insertError } = await supabase
        .from('profiles')
        .insert({
          id: user.id,
          cmdr_name: finalCmdrName,
          email: user.email,
          avatar_url: user.user_metadata?.avatar_url,
          updated_at: new Date().toISOString(),
        });

      if (insertError) {
        console.error(`⚠️ Ошибка создания профиля для ${user.id}: ${insertError.message}`);
      } else {
        console.log(`➕ Создан профиль для: ${user.id}`);
        createdCount += 1;
      }
    } else if (!profile.cmdr_name || profile.cmdr_name.trim() === '' || profile.cmdr_name === 'UnknownCommander') {
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ cmdr_name: finalCmdrName })
        .eq('id', user.id);

      if (updateError) {
        console.error(`⚠️ Ошибка обновления имени профиля ${user.id}: ${updateError.message}`);
      } else {
        console.log(`✏️ Обновлено имя профиля: ${user.id}`);
        fixedCount += 1;
      }
    }
  }

  console.log('\n🎉 Готово!');
  console.log(`📊 Всего пользователей: ${users.users.length}`);
  console.log(`🆕 Создано профилей: ${createdCount}`);
  console.log(`🔧 Исправлено имен: ${fixedCount}`);
  console.log(`❓ Было без профиля: ${missingProfileCount}`);
}

fixDatabase().catch((error) => {
  console.error('❌ Неожиданная ошибка:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
