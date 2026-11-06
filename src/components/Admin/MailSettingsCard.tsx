'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/supabaseClient';
import { IconInfo } from '@/components/Icons';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * Настройки отправки писем — Админка → Авторизация → «Отправка писем».
 *
 * Письма подтверждения при регистрации отправляет GoTrue (сервис auth стека
 * Supabase). SMTP-ключи лежат в .env стека (/opt/supabase/.env): панель
 * редактирует их через update-agent (маски вместо значений, пароль SMTP
 * нельзя прочитать — только заменить) и одной кнопкой пересоздаёт auth и web.
 * Рядом — живая диагностика (тот же /api/admin/email-health, что раньше был
 * доступен только по прямому запросу) и подсказки, чего именно не хватает.
 */

type SmtpKey = { name: string; value?: string; masked: string; length: number };
type SmtpStatus = {
  webEmailEnabled?: boolean;
  available?: boolean;
  override?: { file: string; passesSmtp: boolean } | null;
  legacySignupKey?: boolean;
  keys?: SmtpKey[];
};
type MailAction = 'enable-signup' | 'enable-site-forms' | 'configure-smtp';
type MailCheck = { id: string; ok: boolean; title: string; detail: string; fix?: string; action?: MailAction };
type MailDiagnostics = { ok?: boolean; summary?: string; checks?: MailCheck[] };

type Draft = {
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_USER: string;
  SMTP_PASS: string;
  SMTP_ADMIN_EMAIL: string;
  SMTP_SENDER_NAME: string;
};

const EMPTY_DRAFT: Draft = {
  SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', SMTP_ADMIN_EMAIL: '', SMTP_SENDER_NAME: '',
};

const FIELDS: Array<{ key: keyof Draft; label: string; placeholder: string; password?: boolean; hint?: string }> = [
  { key: 'SMTP_HOST', label: 'mail.hostLabel', placeholder: 'smtp.yandex.ru', hint: 'mail.hostHint' },
  { key: 'SMTP_PORT', label: 'mail.portLabel', placeholder: '587', hint: 'mail.portHint' },
  { key: 'SMTP_USER', label: 'mail.userLabel', placeholder: 'noreply@edringcolony.ru' },
  { key: 'SMTP_PASS', label: 'mail.passLabel', placeholder: '••••••', password: true, hint: 'mail.passHint' },
  { key: 'SMTP_ADMIN_EMAIL', label: 'mail.fromLabel', placeholder: 'noreply@edringcolony.ru' },
  { key: 'SMTP_SENDER_NAME', label: 'mail.nameLabel', placeholder: 'ED Ring Colony' },
];

const inputStyle = { width: '100%', background: '#141618', border: '1px solid #323538', color: '#e5e7eb', padding: '6px 8px', fontSize: 13, borderRadius: 2 } as const;
const labelStyle = { fontSize: 12, color: '#9ca3af', display: 'grid', gap: 3 } as const;

export default function MailSettingsCard() {
  const { t } = useI18n();
  const [status, setStatus] = useState<SmtpStatus | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [signupOpen, setSignupOpen] = useState<boolean | null>(null);
  const [siteEmail, setSiteEmail] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<'save' | 'apply' | 'check' | 'repair' | null>(null);
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(false);
  const [diag, setDiag] = useState<MailDiagnostics | null>(null);
  const [loadError, setLoadError] = useState('');

  const valueOf = (name: string) => status?.keys?.find((key) => key.name === name);

  const load = useCallback(async () => {
    setMsg('');
    try {
      const res = await authFetch('/api/admin/smtp', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) {
        setLoadError(json.error || t('mail.loadError'));
        setStatus(null);
        return;
      }
      setLoadError('');
      setStatus(json);
      // Несекретные значения показываем как есть; пароль — только факт наличия.
      const byName = (name: string) => (json.keys as SmtpKey[] | undefined)?.find((key) => key.name === name);
      setDraft({
        SMTP_HOST: byName('SMTP_HOST')?.value ?? '',
        SMTP_PORT: byName('SMTP_PORT')?.value ?? '587',
        SMTP_USER: byName('SMTP_USER')?.value ?? '',
        SMTP_PASS: '',
        SMTP_ADMIN_EMAIL: byName('SMTP_ADMIN_EMAIL')?.value ?? '',
        SMTP_SENDER_NAME: byName('SMTP_SENDER_NAME')?.value ?? 'ED Ring Colony',
      });
      // Регистрация открыта = DISABLE_SIGNUP=false; отсутствующий ключ
      // трактуется как «закрыта» (так ставит install.sh и шаблон override).
      setSignupOpen((byName('DISABLE_SIGNUP')?.value ?? 'true').trim().toLowerCase() === 'false');
      setSiteEmail(json.webEmailEnabled === true);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t('mail.loadError'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runDiagnostics = useCallback(async () => {
    setBusy('check'); setMsg('');
    try {
      const res = await authFetch('/api/admin/email-health', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('mail.diagUnavailable'));
      setDiag(json);
      setMsgOk(json.ok === true);
      setMsg(json.summary || (json.ok ? t('mail.readyOk') : t('mail.readyIssues')));
    } catch (e) {
      setMsgOk(false);
      setMsg(e instanceof Error ? e.message : t('mail.diagUnavailable'));
    } finally { setBusy(null); }
  }, []);

  const save = useCallback(async () => {
    setBusy('save'); setMsg(''); setMsgOk(false);
    try {
      // SMTP-ключи стека Supabase (только заполненные поля: пустое = не менять).
      const wanted: Array<[string, string]> = [
        ['SMTP_HOST', draft.SMTP_HOST.trim()],
        ['SMTP_PORT', draft.SMTP_PORT.trim()],
        ['SMTP_USER', draft.SMTP_USER.trim()],
        ['SMTP_ADMIN_EMAIL', draft.SMTP_ADMIN_EMAIL.trim()],
        ['SMTP_SENDER_NAME', draft.SMTP_SENDER_NAME.trim()],
      ];
      if (draft.SMTP_PASS) wanted.push(['SMTP_PASS', draft.SMTP_PASS]);
      if (signupOpen !== null) wanted.push(['DISABLE_SIGNUP', signupOpen ? 'false' : 'true']);
      for (const [key, value] of wanted) {
        if (!value && key !== 'DISABLE_SIGNUP') continue; // необязательные поля не затираем пустотой
        const res = await authFetch('/api/admin/smtp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || t('mail.notSavedKey', { key }));
      }
      // Флаг сайта — обычный ключ .env.production (тот же механизм, что «API-ключи»).
      if (siteEmail !== null) {
        const res = await authFetch('/api/admin/env', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'AUTH_EMAIL_ENABLED', value: siteEmail ? 'true' : 'false' }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || t('mail.notSavedKey', { key: 'AUTH_EMAIL_ENABLED' }));
      }
      setMsgOk(true);
      setMsg(t('mail.savedRestart'));
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t('mail.enableFailed'));
    } finally { setBusy(null); }
  }, [draft, signupOpen, siteEmail, load]);

  const apply = useCallback(async () => {
    if (!window.confirm(
      t('mail.applyConfirm'),
    )) return;
    setBusy('apply'); setMsg(''); setMsgOk(false);
    try {
      const res = await authFetch('/api/admin/smtp/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('mail.applyFailed'));
      setMsgOk(true);
      setMsg(t('mail.applyStarted'));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t('mail.applyFailed'));
    } finally { setBusy(null); }
  }, []);

  /**
   * Починка из диагностики: те же два шага, что делает админ руками, но в
   * один клик — и без шанса поправить не то имя ключа. Для disable_signup в
   * стеке Supabase работает только DISABLE_SIGNUP (compose подставляет его в
   * GOTRUE_DISABLE_SIGNUP), поэтому пишем именно его и затем пересоздаём auth:
   * без пересоздания GoTrue продолжает жить со старым окружением.
   */
  const repair = useCallback(async (action: MailAction) => {
    setBusy('repair'); setMsg(''); setMsgOk(false);
    try {
      if (action === 'enable-signup') {
        const res = await authFetch('/api/admin/smtp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'DISABLE_SIGNUP', value: 'false' }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || t('mail.notSavedKey', { key: 'DISABLE_SIGNUP' }));
        setSignupOpen(true);
      } else if (action === 'enable-site-forms') {
        const res = await authFetch('/api/admin/env', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'AUTH_EMAIL_ENABLED', value: 'true' }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || t('mail.notSavedKey', { key: 'AUTH_EMAIL_ENABLED' }));
        setSiteEmail(true);
      } else {
        // SMTP заполняется только вручную: подставить за админа сервер и пароль нельзя.
        setMsg(t('mail.fillSmtp'));
        return;
      }
      const applied = await authFetch('/api/admin/smtp/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const json = await applied.json();
      if (!applied.ok) throw new Error(json.error || t('mail.applyFailed'));
      setMsgOk(true);
      setMsg(t('mail.enabledStarted'));
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t('mail.enableFailed'));
    } finally { setBusy(null); }
  }, [load]);

  const passSaved = (valueOf('SMTP_PASS')?.length ?? 0) > 0;
  const ready = Boolean(draft.SMTP_HOST.trim()) || Boolean(valueOf('SMTP_HOST')?.value);

  return <section style={{ border: '1px solid #3f3b32', borderRadius: 2, padding: '12px 14px', marginBottom: 16, background: 'rgba(255,157,46,0.04)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <h3 style={{ margin: 0 }}>{t('mail.title')}</h3>
      <span style={{ fontSize: 11, color: '#9ca3af' }}>{t('mail.subtitle')}</span>
    </div>
    <p style={{ color: '#9ca3af', fontSize: 13, margin: '8px 0' }}>
      {t('mail.intro')}
    </p>

    {loadError && <div style={{ border: '1px solid #ef4444', background: 'rgba(239,68,68,0.08)', padding: '8px 10px', fontSize: 13, color: '#fca5a5', borderRadius: 2, marginBottom: 10 }}>
      {loadError}
      {/404|недоступен|не настроен/i.test(loadError) && <div style={{ marginTop: 4, color: '#f3f4f6' }}>
        {t('mail.agentOld')}
        <code style={{ display: 'block', marginTop: 4, whiteSpace: 'pre-wrap' }}>
          docker compose --env-file .env.production --profile monitoring up -d --force-recreate update-agent
        </code>
      </div>}
    </div>}

    {status && !status.available && <div style={{ border: '1px solid #e67e22', background: 'rgba(230,126,34,0.08)', padding: '8px 10px', fontSize: 13, color: '#fdba74', borderRadius: 2, marginBottom: 10 }}>
      {t('mail.noEnv')}
    </div>}

    {status?.override && !status.override.passesSmtp && <div style={{ border: '1px solid #e67e22', background: 'rgba(230,126,34,0.08)', padding: '8px 10px', fontSize: 13, color: '#fdba74', borderRadius: 2, marginBottom: 10 }}>
      {t('mail.overrideFile', { file: status.override.file })}
    </div>}

    {status?.legacySignupKey && (
      <div style={{ border: '1px solid #e67e22', background: 'rgba(230,126,34,0.08)', padding: '8px 10px', fontSize: 13, color: '#fdba74', borderRadius: 2, marginBottom: 10 }}>
        {t('mail.legacyHead')} <code>GOTRUE_DISABLE_SIGNUP</code> {t('mail.legacyMid')} <code>DISABLE_SIGNUP</code>{t('mail.legacyTail')}
      </div>
    )}

    <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginBottom: 10 }}>
      {FIELDS.map((field) => {
        const saved = valueOf(field.key);
        return <label key={field.key} style={labelStyle} title={field.hint ? t(field.hint) : undefined}>
          {t(field.label)}
          <input
            style={inputStyle}
            type={field.password ? 'password' : 'text'}
            autoComplete="new-password"
            value={draft[field.key]}
            placeholder={field.key === 'SMTP_PASS' && passSaved ? t('mail.passSavedPlaceholder') : field.placeholder}
            onChange={(e) => setDraft((prev) => ({ ...prev, [field.key]: e.target.value }))}
          />
          {saved && field.key !== 'SMTP_PASS' && (
            <span style={{ fontSize: 11, color: '#6b7280' }}>{t('mail.current', { value: saved.value || saved.masked })}</span>
          )}
        </label>;
      })}
    </div>

    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13, marginBottom: 10 }}>
      <label title={t('mail.signupTitle')}>
        <input type="checkbox" checked={signupOpen === true} disabled={signupOpen === null}
          onChange={(e) => setSignupOpen(e.target.checked)} /> {t('mail.signupLabel')}
      </label>
      <label title={t('mail.siteEmailTitle')}>
        <input type="checkbox" checked={siteEmail === true} disabled={siteEmail === null}
          onChange={(e) => setSiteEmail(e.target.checked)} /> {t('mail.siteEmailLabel')}
      </label>
    </div>

    {msg && <p role="status" style={{ color: msgOk ? '#22c55e' : '#ef4444', fontSize: 13, margin: '6px 0' }}>{msg}</p>}

    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button type="button" className="btn btn-cyan" disabled={busy !== null} onClick={() => void save()}>
        {busy === 'save' ? t('mail.saving') : t('mail.save')}
      </button>
      <button type="button" className="btn btn-cyan" disabled={busy !== null || !ready} title={!ready ? t('mail.smtpFirst') : ''} onClick={() => void apply()}>
        {busy === 'apply' ? t('mail.applying') : t('mail.apply')}
      </button>
      <button type="button" className="btn" disabled={busy !== null} onClick={() => void runDiagnostics()}>
        {busy === 'check' ? t('mail.checking') : t('mail.diagnostics')}
      </button>
    </div>

    {diag && (
      <div style={{ marginTop: 12, borderTop: '1px solid #323538', paddingTop: 10 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <strong style={{ fontSize: 13 }}>{t('mail.diagnostics')}</strong>
          <span style={{ fontSize: 12, color: diag.ok ? '#22c55e' : '#ef4444' }}>
            {diag.ok ? t('mail.allGood') : t('mail.hasIssues')}
          </span>
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4, fontSize: 12.5 }}>
          {(diag.checks ?? []).map((check) => (
            <li key={check.id} style={{ color: check.ok ? '#9ca3af' : '#fca5a5' }}>
              {check.ok ? '✓' : '✗'} <strong style={{ color: '#d1d5db' }}>{check.title}</strong> — {check.detail}
              {check.fix && <div style={{ color: '#fdba74', marginLeft: 14 }}>{t('mail.howToFix', { fix: check.fix })}</div>}
              {!check.ok && check.action && check.action !== 'configure-smtp' && (
                <button type="button" className="btn btn-cyan" style={{ marginLeft: 14, marginTop: 4, fontSize: 12 }}
                  disabled={busy !== null} onClick={() => void repair(check.action as MailAction)}>
                  {busy === 'repair' ? t('mail.enabling') : t('mail.enableApply')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    )}

    <details style={{ marginTop: 10, fontSize: 12.5, color: '#9ca3af' }}>
      <summary style={{ cursor: 'pointer', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <IconInfo size={13} color="#e67e22" /> {t('mail.howItWorks')}
      </summary>
      <ol style={{ margin: '8px 0 0', paddingLeft: 18, display: 'grid', gap: 3 }}>
        <li>{t('mail.li1Head')} <code>/opt/supabase/.env</code> {t('mail.li1Tail')}</li>
        <li>{t('mail.li2Head')} <code>auth</code> {t('mail.li2Mid')} <code>web</code>{t('mail.li2Tail')}</li>
        <li>{t('mail.li3')}</li>
        <li>{t('mail.li4')}</li>
      </ol>
    </details>
  </section>;
}
