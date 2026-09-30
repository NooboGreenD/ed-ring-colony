import type { Metadata } from 'next';
import EngineerTree from '@/components/Engineers/EngineerTree';

export const metadata: Metadata = {
  title: 'Инженеры — схема разблокировки | ED Ring Colony',
  description:
    'Логическое дерево инженеров Elite Dangerous: кто о ком рассказывает, что нужно для знакомства и приглашения, какие чертежи и до какого уровня доступны у каждого.',
};

export default function EngineersPage() {
  return (
    <main style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px 48px' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Инженеры</h1>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 0, marginBottom: 16, maxWidth: 820, lineHeight: 1.6 }}>
        Вертикальная схема разблокировки: сначала — инженеры, к которым можно лететь сразу, во вложенных ветках —
        те, о ком расскажут после работы с наставником. Ищите инженеров и системы, сворачивайте ветки, отмечайте
        свой прогресс и открывайте карточки с условиями встречи и полным списком чертежей.
      </p>
      <EngineerTree />
    </main>
  );
}
