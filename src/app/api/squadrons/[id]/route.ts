import { NextResponse } from 'next/server'
import { createClient, authFromRequest } from '@/lib/supabaseServer'
import { NAME_CHANGE_COOLDOWN_DAYS } from '@/lib/squadronConstants'

export const dynamic = 'force-dynamic';
export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const supabase = await createClient()

    // Проект
    const { data: squadron, error: sErr } = await supabase
      .from('squadrons')
      .select('*')
      .eq('id', squadronId)
      .single()
    if (sErr || !squadron) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Участники с профилями и званиями
    const { data: members } = await supabase
      .from('squadron_member_detail')
      .select('*')
      .eq('squadron_id', squadronId)
      .order('rank_order', { ascending: true })

    // Звания
    const { data: ranks } = await supabase
      .from('squadron_ranks')
      .select('*')
      .eq('squadron_id', squadronId)
      .order('sort_order', { ascending: true })

    // Проекты эскадрильи
    const { data: projects } = await supabase
      .from('project_summary')
      .select('*')
      .eq('squadron_id', squadronId)
      .order('created_at', { ascending: false })

    return NextResponse.json({
      squadron,
      members: members || [],
      ranks: ranks || [],
      projects: projects || [],
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const body = await req.json()
    const { user, supabase } = await authFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Проверка прав: can_edit_squadron
    const { data: membership } = await supabase
      .from('squadron_member_detail')
      .select('can_edit_squadron')
      .eq('squadron_id', squadronId)
      .eq('user_id', user.id)
      .single()

    if (!membership || !membership.can_edit_squadron) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Получаем текущие данные эскадрильи для проверок
    const { data: current } = await supabase
      .from('squadrons')
      .select('name, name_changed_at')
      .eq('id', squadronId)
      .single()

    if (!current) {
      return NextResponse.json({ error: 'Squadron not found' }, { status: 404 })
    }

    const update: Record<string, any> = {}

    // Проверка ограничения на смену имени (30 дней)
    if (body.name !== undefined && body.name !== current.name) {
      if (current.name_changed_at) {
        const lastChange = new Date(current.name_changed_at)
        const now = new Date()
        const diffDays = (now.getTime() - lastChange.getTime()) / (1000 * 60 * 60 * 24)
        if (diffDays < NAME_CHANGE_COOLDOWN_DAYS) {
          const daysLeft = Math.ceil(NAME_CHANGE_COOLDOWN_DAYS - diffDays)
          return NextResponse.json(
            { error: `Название можно менять не чаще раз в ${NAME_CHANGE_COOLDOWN_DAYS} дней. Подождите ещё ${daysLeft} дн.` },
            { status: 429 }
          )
        }
      }
      update.name = body.name
      update.name_changed_at = new Date().toISOString()
    }

    if (body.tag !== undefined) update.tag = body.tag
    if (body.description !== undefined) update.description = body.description
    if (body.color !== undefined) update.color = body.color
    if (body.icon !== undefined) update.icon = body.icon
    if (body.status !== undefined) update.status = body.status
    if (body.allegiance !== undefined) update.allegiance = body.allegiance
    if (body.power !== undefined) update.power = body.power
    if (body.language !== undefined) update.language = body.language
    if (body.timezone !== undefined) update.timezone = body.timezone
    if (body.member_limit !== undefined) update.member_limit = body.member_limit
    if (body.discord_url !== undefined) update.discord_url = body.discord_url
    if (body.website_url !== undefined) update.website_url = body.website_url
    if (body.recruitment_message !== undefined) update.recruitment_message = body.recruitment_message
    if (body.activity_type !== undefined) update.activity_type = body.activity_type
    if (body.is_open_recruitment !== undefined) update.is_open_recruitment = body.is_open_recruitment
    if (body.home_system !== undefined) update.home_system = body.home_system

    const { data, error } = await supabase
      .from('squadrons')
      .update(update)
      .eq('id', squadronId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ squadron: data })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const { user, supabase } = await authFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Только создатель может удалить
    const { data: squadron } = await supabase
      .from('squadrons')
      .select('created_by')
      .eq('id', squadronId)
      .single()

    if (!squadron || squadron.created_by !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    await supabase.from('squadrons').delete().eq('id', squadronId)
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
