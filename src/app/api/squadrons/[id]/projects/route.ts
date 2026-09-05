import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { z } from 'zod'

export const dynamic = 'force-dynamic';
const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().max(50).optional(),
});

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const supabase = await createClient()

    const { data: projects } = await supabase
      .from('project_summary')
      .select('*')
      .eq('squadron_id', squadronId)
      .order('created_at', { ascending: false })

    return NextResponse.json({ projects: projects || [] })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const body = await req.json()
    const parsed = createSchema.parse(body)
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Проверка прав: can_manage_projects
    const { data: membership } = await supabase
      .from('squadron_member_detail')
      .select('can_manage_projects')
      .eq('squadron_id', squadronId)
      .eq('user_id', user.id)
      .single()

    if (!membership || !membership.can_manage_projects) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data: project, error } = await supabase
      .from('projects')
      .insert({
        name: parsed.name,
        description: parsed.description || null,
        color: parsed.color || '#3b82f6',
        icon: parsed.icon || 'squadron',
        squadron_id: squadronId,
        created_by: user.id,
      })
      .select()
      .single()

    if (error) throw error

    // Создатель автоматически становится лидером проекта
    await supabase.from('project_members').insert({
      project_id: project.id,
      user_id: user.id,
      role: 'leader',
    })

    return NextResponse.json({ project })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
