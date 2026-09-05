import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
const reportSchema = z.object({
  post_id: z.number().int().positive().optional(),
  thread_id: z.number().int().positive().optional(),
  reason: z.string().min(1).max(1000),
});

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const parse = reportSchema.safeParse(body);
  if (!parse.success) return NextResponse.json({ error: 'Invalid data', details: parse.error.flatten() }, { status: 400 });

  if (!parse.data.post_id && !parse.data.thread_id) {
    return NextResponse.json({ error: 'post_id or thread_id required' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('forum_reports')
    .insert({
      reporter_id: user.id,
      post_id: parse.data.post_id || null,
      thread_id: parse.data.thread_id || null,
      reason: parse.data.reason,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ report: data });
}
