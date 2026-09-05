interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: { text: string };
}

export async function sendDiscordNotification({
  content,
  username = 'ED Ring Colony',
  avatar_url,
  embeds,
}: {
  content?: string;
  username?: string;
  avatar_url?: string;
  embeds?: DiscordEmbed[];
}) {
  const res = await fetch('/api/discord/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, username, avatar_url, embeds }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('Discord webhook failed:', err);
    throw new Error('Discord webhook failed');
  }
}

export function buildHubUpdateEmbed(hubName: string, status: string, progress: number, url?: string): DiscordEmbed {
  const statusColors: Record<string, number> = {
    planned: 0x888888,
    building: 0xff9d2e,
    done: 0x4caf50,
  };

  return {
    title: `🔧 ${hubName}`,
    description: `Статус обновлён: **${status}**\nПрогресс: **${progress}%**`,
    url,
    color: statusColors[status] || 0x94a3b8,
    timestamp: new Date().toISOString(),
  };
}
