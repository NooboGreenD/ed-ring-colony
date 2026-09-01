import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const { searchParams } = new URL(req.url)
    const chatType = searchParams.get('type') || 'general'
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)
    const before = searchParams.get('before')

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Проверка: пользователь в эскадрилье?
    const { data: membership } = await supabase
      .from('squadron_members')
      .select('id')
      .eq('squadron_id', squadronId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 })
    }

    // Загружаем сообщения без join (избегаем проблемы schema cache)
    let query = supabase
      .from('squadron_chat_messages')
      .select('id, squadron_id, user_id, content, chat_type, created_at, updated_at')
      .eq('squadron_id', squadronId)
      .eq('chat_type', chatType)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (before) {
      query = query.lt('created_at', before)
    }

    const { data: messages, error } = await query
    if (error) throw error

    // Подгружаем профили отдельно
    const userIds = [...new Set((messages || []).map(m => m.user_id))]
    let profilesMap: Record<string, { cmdr_name: string | null; avatar_url: string | null }> = {}
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, cmdr_name, avatar_url')
        .in('id', userIds)
      for (const p of (profiles || [])) {
        profilesMap[p.id] = { cmdr_name: p.cmdr_name, avatar_url: p.avatar_url }
      }
    }

    const enrichedMessages = (messages || []).map(m => ({
      ...m,
      profiles: profilesMap[m.user_id] || null,
    }))

    return NextResponse.json({ messages: enrichedMessages })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const body = await req.json()
    const { content, chat_type = 'general' } = body

    if (!content?.trim()) {
      return NextResponse.json({ error: 'Content required' }, { status: 400 })
    }
    if (content.length > 2000) {
      return NextResponse.json({ error: 'Max 2000 chars' }, { status: 400 })
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Проверка: пользователь в эскадрилье?
    const { data: membership } = await supabase
      .from('squadron_members')
      .select('id, rank_id')
      .eq('squadron_id', squadronId)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 })
    }

    // Для officer-chat проверяем права
    if (chat_type === 'officer') {
      const { data: rank } = await supabase
        .from('squadron_ranks')
        .select('can_manage_members, can_manage_projects, can_manage_ranks, can_edit_squadron')
        .eq('id', membership.rank_id)
        .single()

      const hasOfficerAccess = rank && (
        rank.can_manage_members || rank.can_manage_projects ||
        rank.can_manage_ranks || rank.can_edit_squadron
      )

      if (!hasOfficerAccess) {
        return NextResponse.json({ error: 'Officer access required' }, { status: 403 })
      }
    }

    const { data: insertedRows, error } = await supabase
      .from('squadron_chat_messages')
      .insert({
        squadron_id: squadronId,
        user_id: user.id,
        content: content.trim(),
        chat_type,
      })
      .select('id, squadron_id, user_id, content, chat_type, created_at, updated_at')

    if (error) {
      console.error('[CHAT POST] Insert error:', error)
      throw error
    }

    const rawMessage = insertedRows?.[0] || null
    if (!rawMessage) {
      return NextResponse.json({ error: 'Message not returned after insert' }, { status: 500 })
    }

    // Подгружаем профиль отправителя отдельно
    let profile: { cmdr_name: string | null; avatar_url: string | null } | null = null
    const { data: senderProfile } = await supabase
      .from('profiles')
      .select('cmdr_name, avatar_url')
      .eq('id', rawMessage.user_id)
      .single()
    if (senderProfile) profile = senderProfile

    const message = { ...rawMessage, profiles: profile }

    // Уведомления при @упоминании
    const mentionNames = (content.match(/@[A-Za-z0-9_\-]+/g) || [])
      .map((m: string) => m.slice(1))
      .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)

    if (mentionNames.length > 0) {
      const { data: mentionedMembers } = await supabase
        .from('squadron_member_detail')
        .select('user_id, cmdr_name')
        .eq('squadron_id', squadronId)
        .in('cmdr_name', mentionNames)

      const senderName = message?.profiles?.cmdr_name || 'Пилот'

      for (const m of (mentionedMembers || [])) {
        if (m.user_id === user.id) continue
        await supabase.from('user_notifications').insert({
          user_id: m.user_id,
          type: 'squadron_chat_mention',
          title: `Упоминание в чате эскадрильи`,
          body: `${senderName}: ${content.trim().slice(0, 120)}`,
          href: `/squadrons/${squadronId}?tab=chat`,
          metadata: { squadron_id: squadronId, message_id: message.id, chat_type },
        })
      }
    }

    return NextResponse.json({ message })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
