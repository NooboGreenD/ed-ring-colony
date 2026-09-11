import { NextResponse } from 'next/server'
import { createClient, authFromRequest } from '@/lib/supabaseServer'
import { NAME_CHANGE_COOLDOWN_DAYS } from '@/lib/squadronConstants'
import { getSquadronMembership, loadSquadronMembers, loadSquadronProjects } from '@/lib/squadronData'

export const dynamic = 'force-dynamic';
export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = Number.parseInt(params.id, 10)
    if (!Number.isSafeInteger(squadronId) || squadronId <= 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const supabase = await createClient()

    const { data: squadron, error: sErr } = await supabase
      .from('squadrons')
      .select('*')
      .eq('id', squadronId)
      .maybeSingle()
    if (sErr || !squadron) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Associated collections are enrichments of the public squadron record.
    // Do not blank the entire detail page while an older installation is
    // missing a related table/view or a supplemental query is temporarily slow.
    const [membersResult, ranksResult, projectsResult] = await Promise.allSettled([
      loadSquadronMembers(supabase, squadronId),
      supabase
        .from('squadron_ranks')
        .select('*')
        .eq('squadron_id', squadronId)
        .order('sort_order', { ascending: true }),
      loadSquadronProjects(supabase, squadronId),
    ])
    if (membersResult.status === 'rejected') {
      console.warn('[squadrons/:id GET] Could not load members:', membersResult.reason)
    }
    if (projectsResult.status === 'rejected') {
      console.warn('[squadrons/:id GET] Could not load projects:', projectsResult.reason)
    }
    const ranks = ranksResult.status === 'fulfilled' && !ranksResult.value.error
      ? ranksResult.value.data || []
      : []
    if (ranksResult.status === 'rejected') {
      console.warn('[squadrons/:id GET] Could not load ranks:', ranksResult.reason)
    } else if (ranksResult.value.error) {
      console.warn('[squadrons/:id GET] Could not load ranks:', ranksResult.value.error.message)
    }

    return NextResponse.json({
      squadron,
      members: membersResult.status === 'fulfilled' ? membersResult.value : [],
      ranks,
      projects: projectsResult.status === 'fulfilled' ? projectsResult.value : [],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load squadron'
    console.error('[squadrons/:id GET]', message)
    return NextResponse.json({ error: 'Could not load squadron' }, { status: 500 })
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const body = await req.json()
    const { user, supabase } = await authFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Read rank permissions from the base tables so editing keeps working if
    // the optional squadron_member_detail view is absent.
    const membership = await getSquadronMembership(supabase, squadronId, user.id)

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
