import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { z } from 'zod';
import { loadProjectSummaries } from '@/lib/squadronData';

export const dynamic = 'force-dynamic';
const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().max(50).optional(),
});

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);
    const offset = parseInt(searchParams.get('offset') || '0');

    const supabase = await createClient();
    const projects = await loadProjectSummaries(supabase, { status, limit, offset });

    return NextResponse.json({ projects });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = createSchema.parse(body);

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: project, error } = await supabase
      .from('projects')
      .insert({
        name: parsed.name,
        description: parsed.description || null,
        color: parsed.color || '#3b82f6',
        icon: parsed.icon || 'squadron',
        created_by: user.id,
      })
      .select()
      .single();

    if (error) throw error;

    // Создатель автоматически становится лидером
    await supabase.from('project_members').insert({
      project_id: project.id,
      user_id: user.id,
      role: 'leader',
    });

    return NextResponse.json({ project });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
