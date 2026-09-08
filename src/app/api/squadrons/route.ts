import { NextResponse } from 'next/server'
import { authFromRequest, createClient, createServiceClient } from '@/lib/supabaseServer'
import { z } from 'zod'
import { SQUADRON_MEMBER_LIMIT } from '@/lib/squadronConstants'

export const dynamic = 'force-dynamic';
const createSchema = z.object({
  name: z.string().min(1).max(100),
  tag: z.string().min(2).max(10).regex(/^[A-Za-z0-9]+$/).optional(),
  description: z.string().max(1000).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().max(50).optional(),
  allegiance: z.string().max(50).optional(),
  power: z.string().max(50).optional(),
  language: z.string().max(50).optional(),
  timezone: z.string().max(50).optional(),
  member_limit: z.number().min(1).max(SQUADRON_MEMBER_LIMIT).optional(),
  discord_url: z.string().max(500).optional(),
  website_url: z.string().max(500).optional(),
  recruitment_message: z.string().max(1000).optional(),
  activity_type: z.string().max(50).optional(),
  is_open_recruitment: z.boolean().optional(),
  home_system: z.string().max(100).optional(),
});

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)
    const offset = parseInt(searchParams.get('offset') || '0')

    const supabase = await createClient()
    let query = supabase
      .from('squadron_summary')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({ squadrons: data })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const parsed = createSchema.parse(body)

    const { user, supabase } = await authFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Проверка: пилот уже в эскадрилье?
    const { data: existing } = await supabase
      .from('squadron_members')
      .select('squadron_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (existing) {
      return NextResponse.json({ error: 'Вы уже состоите в эскадрилье. Сначала покиньте текущую.' }, { status: 409 })
    }

    // Используем service client для создания эскадрильи,
    // чтобы триггер on_squadron_created мог создать звания и добавить создателя
    // (RLS на squadron_ranks/squadron_members требует членства, которого ещё нет)
    const service = createServiceClient()
    const { data: squadron, error } = await service
      .from('squadrons')
      .insert({
        name: parsed.name,
        tag: parsed.tag || null,
        description: parsed.description || null,
        color: parsed.color || '#3b82f6',
        icon: parsed.icon || 'squadron',
        allegiance: parsed.allegiance || 'Independent',
        power: parsed.power || null,
        language: parsed.language || 'Russian',
        timezone: parsed.timezone || 'Moscow',
        member_limit: SQUADRON_MEMBER_LIMIT,
        discord_url: parsed.discord_url || null,
        website_url: parsed.website_url || null,
        recruitment_message: parsed.recruitment_message || null,
        activity_type: parsed.activity_type || 'Mixed',
        is_open_recruitment: parsed.is_open_recruitment ?? true,
        home_system: parsed.home_system || null,
        created_by: user.id,
      })
      .select()
      .single()

    if (error) throw error

    // Триггер автоматически создаст звания и назначит командира

    return NextResponse.json({ squadron })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
