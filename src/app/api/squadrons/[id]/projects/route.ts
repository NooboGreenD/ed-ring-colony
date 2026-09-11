import { NextResponse } from 'next/server'
import { createClient, authFromRequest } from '@/lib/supabaseServer'
import { z } from 'zod'
import { getSquadronMembership, loadSquadronProjects } from '@/lib/squadronData'

export const dynamic = 'force-dynamic';
const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().max(50).optional(),
});

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = Number.parseInt(params.id, 10)
    if (!Number.isSafeInteger(squadronId) || squadronId <= 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const supabase = await createClient()
    const projects = await loadSquadronProjects(supabase, squadronId)
    return NextResponse.json({ projects })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load squadron projects'
    console.error('[squadrons/:id/projects GET]', message)
    return NextResponse.json({ error: 'Could not load squadron projects' }, { status: 500 })
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const squadronId = parseInt(params.id)
    const body = await req.json()
    const parsed = createSchema.parse(body)
    const { user, supabase } = await authFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Проверка прав: can_manage_projects
    const membership = await getSquadronMembership(supabase, squadronId, user.id)

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
