import { NextResponse } from 'next/server';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

export async function POST(req: Request) {
  if (!DISCORD_WEBHOOK_URL) {
    return NextResponse.json({ error: 'Discord webhook not configured' }, { status: 500 });
  }

  const body = await req.json();
  const { content, username, avatar_url, embeds } = body;

  if (!content && !embeds) {
    return NextResponse.json({ error: 'content or embeds required' }, { status: 400 });
  }

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: content || undefined,
        username: username || 'ED Ring Colony',
        avatar_url: avatar_url || undefined,
        embeds: embeds || undefined,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: 'Discord error', details: text }, { status: 502 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
