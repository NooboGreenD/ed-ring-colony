const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabaseUrl = 'https://sgukfplhxdhmkqponwft.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNndWtmcGxoeGRobWtxcG9ud2Z0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4Njg4OTg1NywiZXhwIjoyMTAyNDY1ODU3fQ.XjPlqGTwT55I-Wc8qW9HvDLLKrhhIj48noAoiHFD27I';

const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: {
    transport: ws
  }
});

async function fixDatabase() {
  console.log('🔍 Анализ ситуации...');

  // 1. Получаем всех пользователей из auth
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
    
    // Приоритет: метаданные -> email -> дефолт
    let finalCmdrName = cmdrNameFromMeta || cmdrNameFromEmail;
    
    // Проверка существования профиля
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, cmdr_name')
      .eq('id', user.id)
      .single();

    if (profileError && profileError.code === 'PGRST116') {
      // Профиль не найден, создаем
      missingProfileCount++;
      const { error: insertError } = await supabase
        .from('profiles')
        .insert({
          id: user.id,
          cmdr_name: finalCmdrName,
          email: user.email,
          avatar_url: user.user_metadata?.avatar_url,
          discord_id: user.user_metadata?.sub,
          updated_at: new Date().toISOString()
        });
      
      if (insertError) {
        console.error(`⚠️ Ошибка создания профиля для ${user.email}: ${insertError.message}`);
      } else {
        console.log(`➕ Создан профиль для: ${user.email} (CMDR: ${finalCmdrName})`);
        createdCount++;
      }
    } else if (profile) {
      // Профиль есть, но возможно имя пустое или null
      const currentName = profile.cmdr_name;
      if (!currentName || currentName.trim() === '' || currentName === 'UnknownCommander') {
        const { error: updateError } = await supabase
          .from('profiles')
          .update({ cmdr_name: finalCmdrName })
          .eq('id', user.id);
        
        if (updateError) {
          console.error(`⚠️ Ошибка обновления имени для ${user.email}: ${updateError.message}`);
        } else {
          console.log(`✏️ Обновлено имя для: ${user.email} (${currentName} -> ${finalCmdrName})`);
          fixedCount++;
        }
      } else {
        console.log(`✅ OK: ${user.email} (CMDR: ${currentName})`);
      }
    }
  }

  console.log('\n🎉 Готово!');
  console.log(`📊 Всего пользователей: ${users.users.length}`);
  console.log(`🆕 Создано профилей: ${createdCount}`);
  console.log(`🔧 Исправлено имен: ${fixedCount}`);
  console.log(`❓ Было без профиля: ${missingProfileCount}`);
  
  console.log('\n💡 Следующий шаг: Очистите LocalStorage в браузере и войдите снова.');
}

fixDatabase().catch(console.error);
