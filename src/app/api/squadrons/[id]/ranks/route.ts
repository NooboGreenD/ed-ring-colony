import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { z } from 'zod'

export const dynamic = 'force-dynamic';
const rankSchema = z.object({
  name: z.string().min(1).max(100),
  sort_order: z.number().int().min(0).optional(),
  can_manage_projects: z.boolean().optional(),
  can_manage_members: z.boolean().optional(),
  can_manage_ranks: z.boolean().optional(),
  can_edit_squadron: z.boolean().optional(),
});

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const { data } = await supabase
    .from('squadron_ranks')
    .select('*')
    .eq('squadron_id', parseInt(params.id))
    .order('sort_order', { ascending: true })
  return NextResponse.json({ ranks: data || [] })
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const body = await req.json()
    const parsed = rankSchema.parse(body)
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Проверка прав: can_manage_ranks
    const { data: membership } = await supabase
      .from('squadron_member_detail')
      .select('can_manage_ranks')
      .eq('squadron_id', squadronId)
      .eq('user_id', user.id)
      .single()

    if (!membership || !membership.can_manage_ranks) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Проверка лимита: max 20 званий (5 дефолтных + 15 кастомных)
    const { count } = await supabase
      .from('squadron_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('squadron_id', squadronId)

    if (count && count >= 20) {
      return NextResponse.json({ error: 'Достигнут лимит званий (максимум 20)' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('squadron_ranks')
      .insert({
        squadron_id: squadronId,
        name: parsed.name,
        sort_order: parsed.sort_order ?? 99,
        is_default: false,
        can_manage_projects: parsed.can_manage_projects ?? false,
        can_manage_members: parsed.can_manage_members ?? false,
        can_manage_ranks: parsed.can_manage_ranks ?? false,
        can_edit_squadron: parsed.can_edit_squadron ?? false,
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ rank: data })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const { rank_id, ...updates } = await req.json()
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Проверка прав: can_manage_ranks
    const { data: membership } = await supabase
      .from('squadron_member_detail')
      .select('can_manage_ranks')
      .eq('squadron_id', squadronId)
      .eq('user_id', user.id)
      .single()

    if (!membership || !membership.can_manage_ranks) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Нельзя редактировать дефолтные звания (кроме sort_order)
    const { data: targetRank } = await supabase
      .from('squadron_ranks')
      .select('is_default')
      .eq('id', rank_id)
      .eq('squadron_id', squadronId)
      .single()

    if (!targetRank) {
      return NextResponse.json({ error: 'Rank not found' }, { status: 404 })
    }

    const allowedUpdates: Record<string, any> = {}
    if (updates.sort_order !== undefined) allowedUpdates.sort_order = updates.sort_order

    if (!targetRank.is_default) {
      if (updates.name !== undefined) allowedUpdates.name = updates.name
      if (updates.can_manage_projects !== undefined) allowedUpdates.can_manage_projects = updates.can_manage_projects
      if (updates.can_manage_members !== undefined) allowedUpdates.can_manage_members = updates.can_manage_members
      if (updates.can_manage_ranks !== undefined) allowedUpdates.can_manage_ranks = updates.can_manage_ranks
      if (updates.can_edit_squadron !== undefined) allowedUpdates.can_edit_squadron = updates.can_edit_squadron
    }

    const { data, error } = await supabase
      .from('squadron_ranks')
      .update(allowedUpdates)
      .eq('id', rank_id)
      .eq('squadron_id', squadronId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ rank: data })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const { rank_id } = await req.json()
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Проверка прав: can_manage_ranks
    const { data: membership } = await supabase
      .from('squadron_member_detail')
      .select('can_manage_ranks')
      .eq('squadron_id', squadronId)
      .eq('user_id', user.id)
      .single()

    if (!membership || !membership.can_manage_ranks) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Нельзя удалить дефолтное звание
    const { data: targetRank } = await supabase
      .from('squadron_ranks')
      .select('is_default')
      .eq('id', rank_id)
      .eq('squadron_id', squadronId)
      .single()

    if (!targetRank) {
      return NextResponse.json({ error: 'Rank not found' }, { status: 404 })
    }
    if (targetRank.is_default) {
      return NextResponse.json({ error: 'Нельзя удалить стандартное звание' }, { status: 400 })
    }

    // Проверка: нет ли пилотов с этим званием
    const { data: membersWithRank } = await supabase
      .from('squadron_members')
      .select('id')
      .eq('rank_id', rank_id)
      .limit(1)

    if (membersWithRank && membersWithRank.length > 0) {
      return NextResponse.json({ error: 'Сначала переведите всех пилотов с этого звания на другое' }, { status: 400 })
    }

    await supabase
      .from('squadron_ranks')
      .delete()
      .eq('id', rank_id)
      .eq('squadron_id', squadronId)

    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
