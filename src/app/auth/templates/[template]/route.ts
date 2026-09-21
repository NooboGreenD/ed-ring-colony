const templates = {
  signup: { title: 'Подтвердите почту — ED Ring Colony', text: 'Вы запросили регистрацию в ED Ring Colony.', button: 'Подтвердить email' },
  recovery: { title: 'Восстановление доступа — ED Ring Colony', text: 'Вы запросили смену пароля ED Ring Colony.', button: 'Восстановить доступ' },
};

// GoTrue downloads these PUBLIC templates, then expands the Go template fields.
// No actual token or user data is ever returned by this endpoint.
export async function GET(_request: Request, { params }: { params: Promise<{ template: string }> }) {
  const { template } = await params;
  if (template !== 'signup' && template !== 'recovery') return new Response('Not found', { status: 404 });
  const content = templates[template];
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${content.title}</title></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#152638;padding:24px">
<h1>${content.title}</h1><p>${content.text}</p>
<p><a href="{{ .SiteURL }}/auth/email#token_hash={{ .TokenHash }}&amp;type=${template}">${content.button}</a></p>
<p>Открыв страницу, подтвердите действие кнопкой. Ссылка действует один час и используется один раз.</p>
<p>Если это были не вы, не нажимайте кнопку и просто удалите письмо. Не пересылайте это письмо другим людям.</p>
</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
