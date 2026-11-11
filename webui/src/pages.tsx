import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Confirmation, GroupPage, GroupState, LanguagePreference, ModuleMetadata, Preference, RuntimeStatus, SettingsDescriptor } from '../../shared/schemas';
import { languagePreferences } from '../../shared/schemas';
import { action, ApiError, errorCode, query } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import type { FormSnapshot } from './SchemaForm';
import { ResourceMetrics } from './ResourceMetrics';

const SchemaForm = lazy(() => import('./SchemaForm').then((module) => ({ default: module.SchemaForm })));

function useResource<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let current = true;
    setError(undefined); setData(undefined);
    void query<T>(path).then((value) => { if (current) setData(value); }).catch((failure: unknown) => { if (current) setError(errorCode(failure)); });
    return () => { current = false; };
  }, [path, version]);
  return { data, error, refresh: () => setVersion((value) => value + 1) };
}

function Loading({ error, retry }: { error?: string; retry(): void }) {
  const { t } = useTranslation();
  return error ? <div className="notice error" role="alert"><p>{t(`common:errors.${error}`)}</p><button onClick={retry}>{t('common:actions.retry')}</button></div> : <p className="loading" role="status">{t('state.loading')}</p>;
}

export function StatusPage() {
  const { t, i18n } = useTranslation();
  const { data, error, refresh } = useResource<RuntimeStatus>('/api/status');
  if (!data) return <Loading error={error} retry={refresh} />;
  return <>
    <div className="section-tools"><button onClick={refresh}>{t('common:actions.refresh')}</button></div>
    <table className="status-table"><thead><tr><th>{t('status.component')}</th><th>{t('status.state')}</th></tr></thead>
      <tbody>{(['http', 'polling'] as const).map((key) => <tr key={key}><th scope="row">{t(`status.${key}`)}</th><td><span className={`state-badge state-${data[key]}`}>{t(`common:states.${data[key]}`)}</span></td></tr>)}</tbody>
    </table>
    <dl className="metrics">
      <div><dt>{t('status.uptime')}</dt><dd>{t('status.uptimeValue', { hours: Math.floor(data.uptimeSeconds / 3600), minutes: Math.floor(data.uptimeSeconds / 60) % 60, seconds: Math.floor(data.uptimeSeconds) % 60 })}</dd></div>
      <div><dt>{t('status.updates')}</dt><dd>{new Intl.NumberFormat(i18n.language).format(data.updateCount)}</dd></div>
      <div><dt>{t('status.groups')}</dt><dd>{new Intl.NumberFormat(i18n.language).format(data.authorizedGroupCount)}</dd></div>
    </dl>
    <section className="log-line"><h2>{t('status.lastError')}</h2>{data.lastApiError ? <><p>{t(`common:errors.${data.lastApiError.code}`, { defaultValue: t('common:errors.UNAVAILABLE') })}</p><p className="help">{t('status.errorAt', { time: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(data.lastApiError.at)) })}</p></> : <p>{t('status.noError')}</p>}</section>
    <p className="help section-footnote">{t('status.footnote')}</p>
    <ResourceMetrics snapshot={data.resources} />
  </>;
}

export function GroupsPage({ onDirty }: { onDirty(value: boolean): void }) {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState(0);
  const { data, error: loadError, refresh } = useResource<GroupPage>(`/api/groups?page=${page}`);
  const [chatId, setChatId] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [notice, setNotice] = useState<string>();
  const date = (value: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  async function mutate(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try { await operation(); } catch (failure) { setError(errorCode(failure)); }
    finally { setBusy(false); }
  }
  if (!data) return <Loading error={loadError} retry={refresh} />;
  return <>
    {error && <div className="notice error" role="alert"><p>{t(error === 'chatId' ? 'groups.invalidId' : `common:errors.${error}`)}</p>{error === 'CONFLICT' && <button onClick={() => { setError(undefined); refresh(); }}>{t('state.reload')}</button>}</div>}
    {notice && <p className="notice" role="status">{t(notice)}</p>}
    <form className="authorize-form" noValidate onSubmit={(event) => {
      event.preventDefault();
      const id = Number(chatId);
      if (!/^-\d+$/.test(chatId) || !Number.isSafeInteger(id) || id >= 0) { setError('chatId'); return; }
      void mutate(async () => {
        const state = await query<GroupState>('/api/groups/state', 'POST', { chatId: id });
        await query('/api/groups', 'PUT', state);
        setChatId(''); onDirty(false); setNotice('state.saved'); refresh();
      });
    }}><div><label htmlFor="chat-id">{t('groups.chatId')}</label><input id="chat-id" inputMode="text" placeholder="-1001234567890" value={chatId} disabled={busy} aria-describedby="chat-id-help" aria-invalid={error === 'chatId'} onChange={(event) => { setChatId(event.target.value); onDirty(Boolean(event.target.value)); setError(undefined); }} /><p className="help" id="chat-id-help">{t('groups.chatIdHelp')}</p></div><button type="submit" className="primary" disabled={busy || !chatId}>{t(busy ? 'common:actions.saving' : 'groups.authorize')}</button></form>
    <div className="section-tools"><span className="help">{t('groups.total', { count: data.total })}</span><button disabled={busy} onClick={refresh}>{t('common:actions.refresh')}</button></div>
    {data.items.length ? <div className="table-scroll" tabIndex={0} role="region" aria-label={t('groups.title')}><table><thead><tr><th>{t('groups.group')}</th><th>{t('groups.authorized')}</th><th>{t('groups.presence')}</th><th>{t('groups.actions')}</th></tr></thead><tbody>
      {data.items.map((group) => <tr key={group.id}><th scope="row"><span>{group.title || t('groups.unknownTitle')}</span><code>{group.id}</code></th><td><time dateTime={group.authorizedAt}>{date(group.authorizedAt)}</time><code>{group.authorizedBy}</code></td><td>{t(group.present ? 'common:yes' : 'common:no')}</td><td><button className="danger-text" disabled={busy} onClick={() => { void mutate(async () => {
        const result = await action('/api/groups/revoke', 'POST', { chatId: group.id, revision: data.revision, groupRevision: group.groupRevision });
        if (result.status !== 'pending_confirmation') throw new ApiError('CONFIRMATION_REQUIRED');
        setConfirmation(result.confirmation);
      }); }}>{t('groups.revoke')}</button></td></tr>)}
    </tbody></table></div> : <div className="empty-state"><span className="empty-mark" aria-hidden="true">[ ]</span><h2>{t('groups.empty')}</h2><p>{t('groups.emptyHelp')}</p></div>}
    <div className="pagination"><button disabled={page === 0 || busy} onClick={() => setPage((value) => value - 1)}>{t('common:actions.previous')}</button><span>{t('groups.page', { page: page + 1, pages: Math.max(1, Math.ceil(data.total / data.pageSize)) })}</span><button disabled={(page + 1) * data.pageSize >= data.total || busy} onClick={() => setPage((value) => value + 1)}>{t('common:actions.next')}</button></div>
    {confirmation && <ConfirmDialog title={t('groups.revokeTitle')} danger busy={busy} confirm={t('groups.revoke')} onCancel={() => { setConfirmation(undefined); setError(undefined); }} onConfirm={() => { void mutate(async () => {
      try {
        const result = await query<{ notificationSent: boolean; left: boolean }>('/api/confirm', 'POST', { token: confirmation.token });
        setNotice(result.notificationSent && result.left ? 'state.saved' : 'groups.partial'); refresh();
      } finally { setConfirmation(undefined); }
    }); }}><p>{t('groups.revokeHelp', { target: confirmation.target })}</p><p className="help">{t('groups.expires', { time: date(confirmation.expiresAt) })}</p></ConfirmDialog>}
  </>;
}

export function SettingsPage({ onDirty, moduleId }: { onDirty(value: boolean): void; moduleId?: string }) {
  const { t } = useTranslation();
  const base = moduleId ? `/api/modules/${encodeURIComponent(moduleId)}` : '/api/settings/core';
  const snapshotPath = moduleId ? `${base}/config` : base;
  const [snapshot, setSnapshot] = useState<FormSnapshot>();
  const [descriptor, setDescriptor] = useState<SettingsDescriptor>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(false);
  const [pending, setPending] = useState<{ confirmation: Confirmation; resolve(): void; reject(error: ApiError): void }>();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    let active = true;
    setSnapshot(undefined); setDescriptor(undefined); setError(undefined);
    void Promise.all([query<FormSnapshot>(snapshotPath), query<SettingsDescriptor>(`${base}/schema`)]).then(([values, shape]) => {
      if (active) { setSnapshot(values); setDescriptor(shape); }
    }).catch((failure: unknown) => { if (active) setError(errorCode(failure)); });
    return () => { active = false; };
  }, [base, snapshotPath, revision]);
  if (!snapshot || !descriptor) return <Loading error={error} retry={() => setRevision((value) => value + 1)} />;
  return <>
    <div className="section-tools"><span className="mono help">{t('state.revision', { revision: snapshot.revision })}</span></div>
    {saved && <p role="status" className="notice">{t('state.saved')}</p>}
    <Suspense fallback={<p role="status">{t('state.loading')}</p>}><SchemaForm key={`${base}-${snapshot.revision}-${revision}`} descriptor={descriptor} snapshot={snapshot} onDirty={(dirty) => { onDirty(dirty); if (dirty) setSaved(false); }} onReload={() => setReload(true)} onSave={async (settings) => {
      const result = await action<FormSnapshot>(snapshotPath, 'PUT', { revision: snapshot.revision, settings });
      if (result.status === 'succeeded') { setSnapshot(result.data); setSaved(true); }
      else if (result.status === 'pending_confirmation') await new Promise<void>((resolve, reject) => setPending({ confirmation: result.confirmation, resolve, reject }));
    }} /></Suspense>
    {pending && <ConfirmDialog title={t('confirmation.settingsTitle')} danger busy={confirming} onCancel={() => { pending.reject(new ApiError('CANCELLED')); setPending(undefined); }} onConfirm={() => {
      if (confirming) return;
      setConfirming(true);
      void query<FormSnapshot>('/api/confirm', 'POST', { token: pending.confirmation.token }).then((next) => { setSnapshot(next); setSaved(true); pending.resolve(); })
        .catch((failure: unknown) => pending.reject(failure instanceof ApiError ? failure : new ApiError(errorCode(failure))))
        .finally(() => { setPending(undefined); setConfirming(false); });
    }}><p>{t('confirmation.settingsHelp')}</p></ConfirmDialog>}
    {reload && <ConfirmDialog title={t('state.leaveTitle')} confirm={t('state.reload')} onCancel={() => setReload(false)} onConfirm={() => { onDirty(false); setReload(false); setSaved(false); setRevision((value) => value + 1); }}><p>{t('state.reloadHelp')}</p></ConfirmDialog>}
  </>;
}

export function ModulesPage({ configure }: { configure(id: string): void }) {
  const { t } = useTranslation();
  const { data, error, refresh } = useResource<ModuleMetadata[]>('/api/modules');
  if (!data) return <Loading error={error} retry={refresh} />;
  if (!data.length) return <div className="empty-state modules-empty"><span className="empty-mark" aria-hidden="true">[ ]</span><h2>{t('modules.empty')}</h2><p>{t('modules.emptyHelp')}</p></div>;
  return <div className="table-scroll"><table><thead><tr><th>{t('modules.name')}</th><th>{t('modules.version')}</th><th>{t('groups.actions')}</th></tr></thead><tbody>{data.map((module) => <tr key={module.id}><th scope="row">{t(module.nameKey)}<p className="help">{t(module.descriptionKey)}</p></th><td>{module.schema_version}</td><td>{module.configurable && <button onClick={() => configure(module.id)}>{t('modules.configure')}</button>}</td></tr>)}</tbody></table></div>;
}

export function PreferencesPage({ onDirty, onSaved }: { onDirty(value: boolean): void; onSaved(preference: Preference): void }) {
  const { data, error, refresh } = useResource<Preference>('/api/preferences');
  if (!data) return <Loading error={error} retry={refresh} />;
  return <PreferenceForm initial={data} onDirty={onDirty} onSaved={onSaved} />;
}

function PreferenceForm({ initial, onDirty, onSaved }: { initial: Preference; onDirty(value: boolean): void; onSaved(preference: Preference): void }) {
  const { t } = useTranslation();
  const [preference, setPreference] = useState(initial);
  const [language, setLanguage] = useState<LanguagePreference>(initial.language);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  return <form className="preferences-form" onSubmit={(event) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setSaved(false); setError(undefined);
    void query<Preference>('/api/preferences', 'PUT', { language }).then((next) => {
      setPreference(next); onDirty(false); setSaved(true); onSaved(next);
    }).catch((failure: unknown) => setError(errorCode(failure))).finally(() => setBusy(false));
  }}>
    {error && <p role="alert" className="notice error">{t(`common:errors.${error}`)}</p>}
    {saved && <p role="status" className="notice">{t(preference.menuSynced ? 'state.saved' : 'preferences.menuPending')}</p>}
    <label htmlFor="language-preference">{t('preferences.language')}</label>
    <select id="language-preference" value={language} disabled={busy} aria-describedby="language-help" onChange={(event) => { const next = event.target.value as LanguagePreference; setLanguage(next); onDirty(next !== preference.language); setSaved(false); }}>
      {languagePreferences.map((value) => <option key={value} value={value}>{t(`common:languages.${value}`)}</option>)}
    </select><p className="help" id="language-help">{t('preferences.languageHelp')}</p><p className="help">{t('preferences.resolved', { language: t(`common:languages.${preference.resolvedLanguage}`) })}</p>
    <div className="form-footer"><span className="help">{t(language === preference.language ? 'state.unchanged' : 'state.dirty')}</span><button className="primary" disabled={busy || (language === preference.language && preference.menuSynced)}>{t(busy ? 'common:actions.saving' : 'common:actions.save')}</button></div>
  </form>;
}
