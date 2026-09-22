import type { Metadata } from 'next';
import { REQUISITES, requisitesAsPlainText } from './requisites';
import CopyButton from './CopyButton';

export const metadata: Metadata = {
  title: 'Реквизиты — ED Ring Colony',
  description: 'Реквизиты организации',
  // Скрытая страница: не индексировать и не переходить по ссылкам
  robots: { index: false, follow: false },
};

export default function DetailsPage() {
  return (
    <div className="details-page">
      <main className="card details-card">
        <p className="details-kicker">Internal document</p>
        <h1>Реквизиты</h1>
        <p className="details-note">
          Страница доступна только по прямой ссылке и не индексируется поисковыми
          системами.
        </p>

        {REQUISITES.map((group) => (
          <section key={group.title} className="details-group">
            <h2>{group.title}</h2>
            <table>
              <tbody>
                {group.items.map((item) => (
                  <tr key={item.label}>
                    <td className="details-label">
                      {item.label}
                      {item.hint ? (
                        <span className="details-hint">{item.hint}</span>
                      ) : null}
                    </td>
                    <td className="details-value">{item.value}</td>
                    <td className="details-copy">
                      <CopyButton text={item.value} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}

        <div className="details-actions">
          <CopyButton text={requisitesAsPlainText()}>
            Скопировать всё
          </CopyButton>
        </div>
      </main>

      <style>{`
        .details-page {
          max-width: 860px;
          margin: 0 auto;
          padding: 32px 16px 64px;
        }
        .details-card h1 {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          letter-spacing: 4px;
          color: var(--orange);
          font-size: 22px;
          margin: 0 0 6px;
        }
        .details-kicker {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 11px;
          letter-spacing: 3px;
          text-transform: uppercase;
          color: var(--muted);
          margin: 0 0 10px;
        }
        .details-note {
          color: var(--muted);
          font-size: 13px;
          margin: 0 0 24px;
        }
        .details-group { margin-bottom: 28px; }
        .details-group h2 {
          font-size: 13px;
          letter-spacing: 3px;
          color: var(--cyan);
          border-bottom: 1px solid var(--line);
          padding-bottom: 8px;
          margin-bottom: 0;
        }
        .details-group table { margin: 0; font-size: 14px; }
        .details-label {
          width: 34%;
          color: var(--muted);
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 11px;
          letter-spacing: 1px;
          text-transform: uppercase;
          vertical-align: top;
          padding-top: 13px;
        }
        .details-hint {
          display: block;
          font-size: 10px;
          text-transform: none;
          letter-spacing: 0;
          opacity: .7;
          margin-top: 4px;
        }
        .details-value {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 14px;
          word-break: break-all;
        }
        .details-copy { width: 1%; text-align: right; }
        .details-copy button {
          white-space: nowrap;
          font-size: 11px;
          padding: 6px 10px;
        }
        .details-actions {
          margin-top: 8px;
          padding-top: 18px;
          border-top: 1px solid var(--line);
        }
        @media (max-width: 640px) {
          .details-group table, .details-group tbody,
          .details-group tr, .details-group td { display: block; width: 100% !important; }
          .details-group td { border-bottom: none; padding: 4px 0; }
          .details-group tr { border-bottom: 1px solid var(--line); padding: 8px 0; }
          .details-copy { text-align: left; }
        }
      `}</style>
    </div>
  );
}
