import type { Metadata } from 'next';
import EngineersHeader from '@/components/Engineers/EngineersHeader';
import EngineerTree from '@/components/Engineers/EngineerTree';

// Язык интерфейса на этапе метаданных ещё неизвестен, поэтому заголовок
// двуязычный — страницу находят и русским, и английским запросом.
export const metadata: Metadata = {
  title: 'Инженеры — схема разблокировки | Engineers | ED Ring Colony',
  description:
    'Логическое дерево инженеров Elite Dangerous: кто о ком рассказывает, что нужно для знакомства и приглашения, какие чертежи и до какого уровня доступны у каждого. Elite Dangerous engineer unlock chart with full interface translation.',
};

export default function EngineersPage() {
  return (
    <main style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px 48px' }}>
      <EngineersHeader />
      <EngineerTree />
    </main>
  );
}
