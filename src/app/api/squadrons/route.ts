import { NextResponse } from 'next/server';
import { authFromRequest, createClient, createServiceClient } from '@/lib/supabaseServer';
import { z } from 'zod';
import { SQUADRON_MEMBER_LIMIT } from '@/lib/squadronConstants';
import { loadSquadronSummaries } from '@/lib/squadronData';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  tag: z.string().trim().min(2).max(10).regex(/^[A-Za-z0-9]+$/).optional(),
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

function boundedInteger(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status')?.trim() || null;
    const limit = boundedInteger(searchParams.get('limit'), 50, 1, 100);
    const offset = boundedInteger(searchParams.get('offset'), 0, 0, 100_000);
    const supabase = await createClient();

    // Build the small public read model from base tables instead of depending
    // on an untracked PostgREST view. A migration recreates the view too, but
    // this endpoint remains available before its schema cache is refreshed.
    const squadrons = await loadSquadronSummaries(supabase, { status, limit, offset });
    return NextResponse.json({ squadrons });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load squadrons';
    console.error('[squadrons GET]', message);
    return NextResponse.json({ error: 'Could not load squadrons' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = createSchema.parse(body);

    const { user } = await authFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // A member relation is authoritative, while created_by covers legacy
    // squadrons made before the automatic membership trigger was available.
    // Use the server-side reader after authenticating so an outdated RLS policy
    // cannot make a commander accidentally create a second squadron.
    const service = createServiceClient();
    const [membershipResponse, createdResponse] = await Promise.all([
      service
        .from('squadron_members')
        .select('squadron_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle(),
      service
        .from('squadrons')
        .select('id')
        .eq('created_by', user.id)
        .limit(1)
        .maybeSingle(),
    ]);
    if (membershipResponse.error) throw membershipResponse.error;
    if (createdResponse.error) throw createdResponse.error;
    if (membershipResponse.data || createdResponse.data) {
      return NextResponse.json({ error: 'Вы уже состоите в эскадрилье. Сначала покиньте текущую.' }, { status: 409 });
    }


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
      .single();

    if (error || !squadron) throw error || new Error('Could not create squadron');
    return NextResponse.json({ squadron });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Некорректные данные эскадрильи' }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : 'Could not create squadron';
    console.error('[squadrons POST]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
