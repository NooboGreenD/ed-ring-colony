import { NextResponse } from 'next/server'
import { authFromRequest } from '@/lib/supabaseServer'

export async function GET(req: Request) {
  const { user, supabase } = await authFromRequest(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // 1. Ищем членство в squadron_members
  const { data: membership } = await supabase
    .from('squadron_members')
    .select('squadron_id')
    .eq('user_id', user.id)
    .maybeSingle()

  let squadronId = membership?.squadron_id ?? null

  // 2. Если нет членства — проверяем, может он создатель
  if (!squadronId) {
    const { data: sq } = await supabase
      .from('squadrons')
      .select('id')
      .eq('created_by', user.id)
      .maybeSingle()
    squadronId = sq?.id ?? null
  }

  if (!squadronId) return NextResponse.json({ squadron: null })

  // 3. Получаем данные эскадрильи
  const { data: squadron } = await supabase
    .from('squadrons')
    .select('*')
    .eq('id', squadronId)
    .maybeSingle()

  // 4. Получаем членов, ранги, проекты
  const { data: members } = await supabase
    .from('squadron_member_detail')
    .select('*')
    .eq('squadron_id', squadronId)

  const { data: ranks } = await supabase
    .from('squadron_ranks')
    .select('*')
    .eq('squadron_id', squadronId)
    .order('sort_order')

  const { data: projects } = await supabase
    .from('squadron_projects')
    .select('*')
    .eq('squadron_id', squadronId)

  return NextResponse.json({
    squadron,
    members: members || [],
    ranks: ranks || [],
    projects: projects || [],
  })
}
