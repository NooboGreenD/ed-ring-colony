import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'

export const dynamic = 'force-dynamic';
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const { data } = await supabase
    .from('squadron_member_detail')
    .select('*')
    .eq('squadron_id', parseInt(params.id))
    .order('rank_order', { ascending: true })
  return NextResponse.json({ members: data || [] })
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const { user_id, rank_id, callsign } = await req.json()
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Проверка прав приглашающего: can_manage_members
    const { data: membership } = await supabase
      .from('squadron_member_detail')
      .select('can_manage_members')
      .eq('squadron_id', squadronId)
      .eq('user_id', user.id)
      .single()

    if (!membership || !membership.can_manage_members) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Проверка: целевой пилот не в другой эскадрилье
    const { data: existing } = await supabase
      .from('squadron_members')
      .select('squadron_id')
      .eq('user_id', user_id)
      .maybeSingle()

    if (existing && existing.squadron_id !== squadronId) {
      return NextResponse.json({ error: 'Пилот уже состоит в другой эскадрилье' }, { status: 409 })
    }

    if (existing && existing.squadron_id === squadronId) {
      return NextResponse.json({ error: 'Пилот уже в этой эскадрилье' }, { status: 409 })
    }

    // Проверка: указанное звание принадлежит этой эскадрилье
    if (rank_id) {
      const { data: rankCheck } = await supabase
        .from('squadron_ranks')
        .select('id')
        .eq('id', rank_id)
        .eq('squadron_id', squadronId)
        .single()
      if (!rankCheck) {
        return NextResponse.json({ error: 'Неверное звание' }, { status: 400 })
      }
    }

    const { data, error } = await supabase
      .from('squadron_members')
      .insert({ squadron_id: squadronId, user_id, rank_id: rank_id || null, callsign: callsign || null })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ member: data })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const { user_id, rank_id, callsign } = await req.json()
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Проверка прав: can_manage_members
    const { data: membership } = await supabase
      .from('squadron_member_detail')
      .select('can_manage_members')
      .eq('squadron_id', squadronId)
      .eq('user_id', user.id)
      .single()

    if (!membership || !membership.can_manage_members) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Нельзя снять звание с самого себя (только через покидание эскадрильи)
    if (user_id === user.id && rank_id === null) {
      return NextResponse.json({ error: 'Нельзя снять звание с себя' }, { status: 400 })
    }

    // Проверка звания
    if (rank_id) {
      const { data: rankCheck } = await supabase
        .from('squadron_ranks')
        .select('id')
        .eq('id', rank_id)
        .eq('squadron_id', squadronId)
        .single()
      if (!rankCheck) {
        return NextResponse.json({ error: 'Неверное звание' }, { status: 400 })
      }
    }

    const update: Record<string, any> = {}
    if (rank_id !== undefined) update.rank_id = rank_id
    if (callsign !== undefined) update.callsign = callsign

    const { data, error } = await supabase
      .from('squadron_members')
      .update(update)
      .eq('squadron_id', squadronId)
      .eq('user_id', user_id)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ member: data })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const { user_id } = await req.json()
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Можно удалить себя или быть удалённым с правами can_manage_members
    const { data: membership } = await supabase
      .from('squadron_member_detail')
      .select('can_manage_members')
      .eq('squadron_id', squadronId)
      .eq('user_id', user.id)
      .single()

    const isSelf = user.id === user_id
    const canManage = membership && membership.can_manage_members

    if (!isSelf && !canManage) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Нельзя выгнать создателя (только через удаление эскадрильи)
    const { data: target } = await supabase
      .from('squadrons')
      .select('created_by')
      .eq('id', squadronId)
      .single()

    if (target && target.created_by === user_id && !isSelf) {
      return NextResponse.json({ error: 'Нельзя выгнать командира эскадрильи' }, { status: 403 })
    }

    await supabase
      .from('squadron_members')
      .delete()
      .eq('squadron_id', squadronId)
      .eq('user_id', user_id)

    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
