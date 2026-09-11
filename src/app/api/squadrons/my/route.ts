import { NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/supabaseServer';
import { loadSquadronForUser } from '@/lib/squadronData';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { user, supabase } = await authFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // This formerly queried two undeclared views and silently turned their
    // failures into empty arrays. Use the authoritative base relationships so
    // the profile's Squadron tab stays visible during a view/schema rollout.
    const details = await loadSquadronForUser(supabase, user.id);
    if (!details) return NextResponse.json({ squadron: null, members: [], ranks: [], projects: [] });
    return NextResponse.json(details);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load squadron';
    console.error('[squadrons/my GET]', message);
    return NextResponse.json({ error: 'Could not load squadron' }, { status: 500 });
  }
}
