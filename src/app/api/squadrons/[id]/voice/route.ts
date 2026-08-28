import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabaseServer'

export const dynamic = 'force-dynamic';

// GET — список комнат и участников
export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const { searchParams } = new URL(req.url)
    const roomId = searchParams.get('roomId')

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: membership } = await supabase
      .from('squadron_members')
      .select('id, rank_id')
      .eq('squadron_id', squadronId)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 })
    }

    const { data: rank } = await supabase
      .from('squadron_ranks')
      .select('can_manage_members, can_manage_projects, can_manage_ranks, can_edit_squadron')
      .eq('id', membership.rank_id)
      .single()

    const isOfficer = rank && (
      rank.can_manage_members || rank.can_manage_projects ||
      rank.can_manage_ranks || rank.can_edit_squadron
    )

    if (roomId) {
      const { data: signals } = await supabase
        .from('squadron_voice_signals')
        .select('*')
        .eq('room_id', parseInt(roomId))
        .or(`target_id.eq.${user.id},target_id.is.null`)
        .order('created_at', { ascending: true })
        .limit(200)

      // Используем service client для обхода RLS и получения реальных имён/аватарок
      // Берём данные из squadron_member_detail, а не profiles — там точно есть имя и аватарка
      const serviceSupabase = createServiceClient()
      const { data: rawParticipants } = await serviceSupabase
        .from('squadron_voice_participants')
        .select('id, room_id, user_id, joined_at, is_muted, is_deafened')
        .eq('room_id', parseInt(roomId))

      const userIds = (rawParticipants || []).map((p: any) => p.user_id).filter(Boolean)
      let memberMap = new Map<string, { cmdr_name: string; avatar_url: string | null }>()
      if (userIds.length > 0) {
        const { data: members } = await serviceSupabase
          .from('squadron_member_detail')
          .select('user_id, cmdr_name, avatar_url')
          .eq('squadron_id', squadronId)
          .in('user_id', userIds)
        memberMap = new Map((members || []).map((m: any) => [m.user_id, m]))
      }

      const participants = (rawParticipants || []).map((p: any) => ({
        id: p.id,
        room_id: p.room_id,
        user_id: p.user_id,
        joined_at: p.joined_at,
        is_muted: p.is_muted,
        is_deafened: p.is_deafened,
        cmdr_name: memberMap.get(p.user_id)?.cmdr_name || 'Неизвестный',
        avatar_url: memberMap.get(p.user_id)?.avatar_url || null,
      }))

      return NextResponse.json({ signals: signals || [], participants: participants || [] })
    }

    let query = supabase
      .from('squadron_voice_room_summary')
      .select('*')
      .eq('squadron_id', squadronId)
      .order('sort_order', { ascending: true })

    if (!isOfficer) {
      query = query.eq('is_officer_only', false)
    }

    const { data: rooms, error } = await query
    if (error) throw error

    return NextResponse.json({ rooms: rooms || [] })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// POST — отправить сигнал или управлять комнатой
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const body = await req.json()
    const { action } = body

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: membership } = await supabase
      .from('squadron_members')
      .select('id, rank_id')
      .eq('squadron_id', squadronId)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 })
    }

    const { data: rank } = await supabase
      .from('squadron_ranks')
      .select('can_manage_members, can_manage_projects, can_manage_ranks, can_edit_squadron')
      .eq('id', membership.rank_id)
      .single()

    const isOfficer = rank && (
      rank.can_manage_members || rank.can_manage_projects ||
      rank.can_manage_ranks || rank.can_edit_squadron
    )

    if (action === 'create_room') {
      if (!isOfficer) {
        return NextResponse.json({ error: 'Officer access required' }, { status: 403 })
      }
      const { name, description, is_officer_only } = body
      if (!name?.trim()) {
        return NextResponse.json({ error: 'Name required' }, { status: 400 })
      }
      const { data, error } = await supabase
        .from('squadron_voice_rooms')
        .insert({
          squadron_id: squadronId,
          name: name.trim(),
          description: description || null,
          is_officer_only: is_officer_only || false,
          created_by: user.id,
        })
        .select()
        .single()
      if (error) throw error
      return NextResponse.json({ room: data })
    }

    if (action === 'delete_room') {
      if (!isOfficer) {
        return NextResponse.json({ error: 'Officer access required' }, { status: 403 })
      }
      const { room_id } = body
      await supabase.from('squadron_voice_rooms').delete().eq('id', room_id).eq('squadron_id', squadronId)
      return NextResponse.json({ success: true })
    }

    if (action === 'signal') {
      const { room_id, signal_type, target_id, payload } = body
      if (!room_id || !signal_type) {
        return NextResponse.json({ error: 'room_id and signal_type required' }, { status: 400 })
      }

      const { data: room } = await supabase
        .from('squadron_voice_rooms')
        .select('is_officer_only')
        .eq('id', room_id)
        .eq('squadron_id', squadronId)
        .single()

      if (!room) {
        return NextResponse.json({ error: 'Room not found' }, { status: 404 })
      }
      if (room.is_officer_only && !isOfficer) {
        return NextResponse.json({ error: 'Officer access required' }, { status: 403 })
      }

      const { data, error } = await supabase
        .from('squadron_voice_signals')
        .insert({
          squadron_id: squadronId,
          room_id,
          sender_id: user.id,
          target_id: target_id || null,
          signal_type,
          payload: payload || {},
        })
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ signal: data })
    }

    if (action === 'join') {
      const { room_id } = body
      if (!room_id) {
        return NextResponse.json({ error: 'room_id required' }, { status: 400 })
      }

      const { data: room } = await supabase
        .from('squadron_voice_rooms')
        .select('is_officer_only')
        .eq('id', room_id)
        .eq('squadron_id', squadronId)
        .single()

      if (!room) {
        return NextResponse.json({ error: 'Room not found' }, { status: 404 })
      }
      if (room.is_officer_only && !isOfficer) {
        return NextResponse.json({ error: 'Officer access required' }, { status: 403 })
      }

      // Получаем ID всех комнат эскадрильи
      const { data: roomIds } = await supabase
        .from('squadron_voice_rooms')
        .select('id')
        .eq('squadron_id', squadronId)
      const ids = (roomIds || []).map((r: any) => r.id)
      if (ids.length > 0) {
        await supabase
          .from('squadron_voice_participants')
          .delete()
          .eq('user_id', user.id)
          .in('room_id', ids)
      }

      const { data, error } = await supabase
        .from('squadron_voice_participants')
        .upsert({
          room_id,
          user_id: user.id,
          is_muted: false,
          is_deafened: false,
        }, { onConflict: 'room_id,user_id' })
        .select()
        .single()

      if (error) throw error

      await supabase.from('squadron_voice_signals').insert({
        squadron_id: squadronId,
        room_id,
        sender_id: user.id,
        target_id: null,
        signal_type: 'join',
        payload: {},
      })

      return NextResponse.json({ participant: data })
    }

    if (action === 'leave') {
      const { room_id } = body
      if (!room_id) {
        return NextResponse.json({ error: 'room_id required' }, { status: 400 })
      }

      await supabase
        .from('squadron_voice_participants')
        .delete()
        .eq('room_id', room_id)
        .eq('user_id', user.id)

      await supabase.from('squadron_voice_signals').insert({
        squadron_id: squadronId,
        room_id,
        sender_id: user.id,
        target_id: null,
        signal_type: 'leave',
        payload: {},
      })

      return NextResponse.json({ success: true })
    }

    if (action === 'status') {
      const { room_id, is_muted, is_deafened } = body
      if (!room_id) {
        return NextResponse.json({ error: 'room_id required' }, { status: 400 })
      }
      const { data, error } = await supabase
        .from('squadron_voice_participants')
        .update({ is_muted: is_muted ?? false, is_deafened: is_deafened ?? false })
        .eq('room_id', room_id)
        .eq('user_id', user.id)
        .select()
        .single()
      if (error) throw error
      return NextResponse.json({ participant: data })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
