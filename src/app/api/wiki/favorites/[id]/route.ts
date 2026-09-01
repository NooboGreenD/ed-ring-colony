import { NextResponse } from 'next/server';
import { createServiceClient } from "@/lib/supabaseServer";
import { authFromRequest } from '@/lib/supabaseServer';

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const { user } = await authFromRequest(request);
  const supabase = createServiceClient();
  
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { error } = await supabase
    .from('wiki_favorites')
    .delete()
    .eq('id', params.id)
    .eq('user_id', user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
