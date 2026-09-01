import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'

export const dynamic = 'force-dynamic';

export async function DELETE(req: Request, { params }: { params: { id: string; messageId: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const messageId = parseInt(params.messageId)

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Проверяем, может ли пользователь удалить сообщение
    const { data: message } = await supabase
      .from('squadron_chat_messages')
      .select('user_id')
      .eq('id', messageId)
      .eq('squadron_id', squadronId)
      .single()

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    const isAuthor = message.user_id === user.id

    // Проверяем, является ли пользователь создателем или has can_manage_members
    let canDelete = isAuthor
    if (!canDelete) {
      const { data: squadron } = await supabase
        .from('squadrons')
        .select('created_by')
        .eq('id', squadronId)
        .single()
      if (squadron?.created_by === user.id) canDelete = true
    }
    if (!canDelete) {
      const { data: membership } = await supabase
        .from('squadron_member_detail')
        .select('can_manage_members')
        .eq('squadron_id', squadronId)
        .eq('user_id', user.id)
        .single()
      if (membership?.can_manage_members) canDelete = true
    }

    if (!canDelete) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { error } = await supabase
      .from('squadron_chat_messages')
      .delete()
      .eq('id', messageId)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
