import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Confirmation } from '../../shared/schemas';
import { aiAdminSnapshotSchema, aiToolCatalogSchema, type AiAdminSnapshot, type AiToolCatalog } from '../../shared/schemas/ai-admin';
import { aiCredentialChangeSchema, aiInteractiveBudget, aiInteractiveDailyRuns } from '../../shared/schemas/ai';
import { action, ApiError, errorCode, query } from './api';
import { AiSetupForm } from './AiSetupForm';
import { ConfirmDialog } from './ConfirmDialog';

const AiSettingsForm = lazy(() => import('./AiSettingsForm').then(module => ({ default: module.AiSettingsForm })));
const AiExtensionPanel = lazy(() => import('./AiExtensionPanel').then(module => ({ default: module.AiExtensionPanel })));

function snapshot(value: unknown): AiAdminSnapshot {
  const parsed = aiAdminSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new ApiError('INVALID_OUTPUT');
  return parsed.data;
}

export function AiAdminPage({ onDirty, clearSensitive }: { onDirty(dirty: boolean): void; clearSensitive: boolean }) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<AiAdminSnapshot>();
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string>();
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [setupDirty, setSetupDirty] = useState(false);
  const [advancedLoaded, setAdvancedLoaded] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [toolCatalog, setToolCatalog] = useState<AiToolCatalog>();
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsError, setToolsError] = useState<ReturnType<typeof errorCode>>();
  const [toolsVersion, setToolsVersion] = useState(0);
  const [secretDirty, setSecretDirty] = useState(false);
  const [extensionDirty, setExtensionDirty] = useState(false);
  const [extensionBusy, setExtensionBusy] = useState(false);
  const [ref, setRef] = useState('');
  const secret = useRef<HTMLInputElement>(null);
  const [intent, setIntent] = useState<'disable' | 'delete' | 'reload'>();
  const [pending, setPending] = useState<{ confirmation: Confirmation; resolve(): void; reject(error: ApiError): void }>();

  useEffect(() => { onDirty(setupDirty || settingsDirty || secretDirty || extensionDirty); }, [setupDirty, settingsDirty, secretDirty, extensionDirty, onDirty]);
  useEffect(() => {
    if (clearSensitive) { if (secret.current) secret.current.value = ''; setSecretDirty(false); }
  }, [clearSensitive]);
  useEffect(() => {
    const input = secret.current;
    const clear = () => { if (secret.current) secret.current.value = ''; setSecretDirty(false); };
    window.addEventListener('pagehide', clear);
    return () => { if (input) input.value = ''; window.removeEventListener('pagehide', clear); };
  }, [data !== undefined, advancedLoaded]);
  useEffect(() => {
    let current = true;
    setError(undefined); setData(undefined);
    void query<unknown>('/api/ai/admin').then(snapshot).then(value => { if (current) setData(value); })
      .catch((failure: unknown) => { if (current) setError(errorCode(failure)); });
    return () => { current = false; };
  }, [version]);
  useEffect(() => {
    if (!advancedLoaded || data?.revision === undefined) return;
    let current = true;
    setToolsLoading(true); setToolsError(undefined); setToolCatalog(undefined);
    void query<unknown>('/api/ai/admin/tools').then(value => {
      const parsed = aiToolCatalogSchema.safeParse(value);
      if (!parsed.success) throw new ApiError('INVALID_OUTPUT');
      if (current) setToolCatalog(parsed.data);
    }).catch((failure: unknown) => { if (current) setToolsError(errorCode(failure)); })
      .finally(() => { if (current) setToolsLoading(false); });
    return () => { current = false; };
  }, [advancedLoaded, toolsVersion, data?.revision]);

  function accept(value: unknown) {
    setData(snapshot(value)); setBlocked(false); setSetupDirty(false); setSettingsDirty(false); setSecretDirty(false); setSaved(true);
    if (secret.current) secret.current.value = '';
  }
  function failed(failure: unknown) {
    const code = errorCode(failure);
    setError(code);
    if (['CONFLICT', 'OUTCOME_UNKNOWN', 'TIMEOUT', 'UNAVAILABLE', 'INVALID_OUTPUT', 'CONFIRMATION_EXPIRED'].includes(code)) setBlocked(true);
  }
  async function mutate(path: string, method: string, body: unknown) {
    if (busy || pending || blocked) throw new ApiError('CANCELLED');
    if (secret.current) secret.current.value = '';
    setSecretDirty(false);
    setBusy(true); setSaved(false); setError(undefined);
    try {
      const result = await action<unknown>(path, method, body);
      if (result.status === 'succeeded') accept(result.data);
      else if (result.status === 'pending_confirmation') {
        setBusy(false);
        await new Promise<void>((resolve, reject) => setPending({ confirmation: result.confirmation, resolve, reject }));
      } else throw new ApiError('INVALID_OUTPUT');
    } catch (failure) { failed(failure); throw failure; }
    finally { setBusy(false); }
  }
  function reload() {
    setBlocked(false); setSetupDirty(false); setSettingsDirty(false); setSecretDirty(false); setExtensionDirty(false); setRef(''); setSaved(false); setVersion(value => value + 1);
    if (secret.current) secret.current.value = '';
  }
  const locked = busy || Boolean(pending) || extensionBusy || blocked || !data?.status.available;
  const fresh = data && !data.settings.enabled && !data.settings.providers.length && !data.settings.presets.length && !data.settings.grants.length;
  const vaultRefValid = ref.startsWith('vault:') && aiCredentialChangeSchema.safeParse({ operation: 'delete', ref }).success;
  if (!data) return error ? <div className="notice error" role="alert"><p>{t(`common:errors.${error}`)}</p><button onClick={reload}>{t('common:actions.retry')}</button></div>
    : <p className="loading" role="status">{t('state.loading')}</p>;
  const recommended = aiInteractiveBudget();
  const usagePresets = data.settings.presets.filter(preset => preset.budgetMode === 'usage');
  const needsRecommended = usagePresets.length > 0 && ((data.settings.limits.dailyRuns ?? 0) < aiInteractiveDailyRuns
    || usagePresets.some(preset => (['maxInputTokens', 'maxOutputTokens', 'maxToolCalls', 'maxDurationMs'] as const).some(key => preset.budget[key] < recommended[key])));
  const recommendationLocked = locked || extensionBusy || setupDirty || settingsDirty || secretDirty || extensionDirty || !needsRecommended;
  const search = data.settings.search;
  const searchProvider = data.settings.providers.find(provider => provider.id === search?.providerId);
  const searchReadiness = !search?.enabled ? 'disabled'
    : !searchProvider?.enabled || new URL(searchProvider.baseUrl).origin !== 'https://api.deepseek.com' ? 'provider'
    : !data.credentials.some(credential => credential.ref === searchProvider.credentialRef && credential.hasValue) ? 'credential'
    : !data.settings.presets.some(preset => preset.tools.some(tool => tool === 'ai.search' || tool === 'ai.fetch')) ? 'noTools' : 'configured';
  return <div className="schema-editor">
    <div className="section-tools"><span className="mono help">{t('state.revision', { revision: data.revision })}</span><button disabled={busy || Boolean(pending) || extensionBusy} onClick={() => setIntent('reload')}>{t('common:actions.refresh')}</button></div>
    {error && <div className="notice error" role="alert"><p>{t(`common:errors.${error}`)}</p>{blocked && <><p>{t('ai.refreshRequired')}</p><button onClick={() => setIntent('reload')}>{t('state.reload')}</button></>}</div>}
    {saved && <p role="status" className="notice">{t('state.saved')}</p>}
    <section aria-labelledby="ai-status"><h2 id="ai-status">{t('ai.status')}</h2>
      <dl className="effective-values">
        <div><dt>{t('ai.configured')}</dt><dd>{t(data.settings.enabled ? 'common:yes' : 'common:no')}</dd></div>
        <div><dt>{t('ai.storageAvailable')}</dt><dd>{t(data.status.available ? 'common:yes' : 'common:no')}</dd></div>
        <div><dt>{t('ai.searchStatus.title')}</dt><dd>{t(`ai.searchStatus.${searchReadiness}`)}</dd></div>
      </dl>
      {!data.status.available && <p className="notice">{t('ai.storageUnavailable')}</p>}
      {!data.settings.providers.length && <p className="notice">{t('ai.blank')}</p>}
      {data.settings.presets.map(preset => <p key={preset.id} className="help">{t('ai.setup.model')}: <code>{preset.model}</code></p>)}
      {data.settings.enabled && <p className="notice">{t('ai.ready')}</p>}
      {data.settings.limits.dailyRuns !== undefined && <p className="help">{t('ai.dailyRunLimit', { limit: data.settings.limits.dailyRuns })}</p>}
      {usagePresets.length > 0 && <><p id="ai-recommended-help" className="help">{t('ai.recommendedHelp')}</p>
        <button disabled={recommendationLocked} aria-describedby="ai-recommended-help" onClick={() => {
          if (recommendationLocked) return;
          const settings = { ...data.settings, presets: data.settings.presets.map(preset => preset.budgetMode !== 'usage' ? preset : { ...preset, budget: { ...preset.budget,
            maxInputTokens: Math.max(preset.budget.maxInputTokens, recommended.maxInputTokens),
            maxOutputTokens: Math.max(preset.budget.maxOutputTokens, recommended.maxOutputTokens),
            maxToolCalls: Math.max(preset.budget.maxToolCalls, recommended.maxToolCalls),
            maxDurationMs: Math.max(preset.budget.maxDurationMs, recommended.maxDurationMs),
          } }), limits: { ...data.settings.limits, dailyRuns: Math.max(data.settings.limits.dailyRuns ?? 0, aiInteractiveDailyRuns) } };
          void mutate('/api/ai/admin', 'PUT', { revision: data.revision, settings }).catch(() => {});
        }}>{t('ai.applyRecommended')}</button></>}
      <p className="help">{t('ai.searchStatus.help')}</p>
      <div className="button-row"><button onClick={() => { setAdvancedLoaded(true); setAdvancedOpen(true); document.getElementById('ai-advanced')?.focus(); }}>{t('ai.searchStatus.open')}</button>
        <button className="danger-text" disabled={locked || !data.settings.enabled} onClick={() => setIntent('disable')}>{t('ai.disable')}</button></div>
    </section>
    {fresh && <AiSetupForm key={`setup-${data.revision}-${version}`} revision={data.revision} disabled={locked || settingsDirty || secretDirty || extensionDirty} clearSensitive={clearSensitive}
      onDirty={setSetupDirty} onSave={input => mutate('/api/ai/setup', 'POST', input)} />}
    <details open={advancedOpen} onToggle={event => { setAdvancedOpen(event.currentTarget.open); if (event.currentTarget.open) setAdvancedLoaded(true); }}><summary id="ai-advanced">{t('ai.advanced')}</summary>
    {advancedLoaded && <Suspense fallback={<p role="status">{t('state.loading')}</p>}>
    <p className="help">{t('ai.advancedHelp')}</p><p className="help">{t('ai.privacy')}</p>
    {setupDirty && <p className="notice">{t('ai.setup.finishFirst')}</p>}
    <dl className="effective-values">
      {(['pendingRuns', 'storageBytes', 'reservedCostMicros', 'settledCostMicros'] as const).map(key => <div key={key}><dt>{t(`ai.${key}`)}</dt><dd>{new Intl.NumberFormat(i18n.language).format(data.status[key])}</dd></div>)}
    </dl>
    {data.settings.presets.some(preset => !preset.pricing) && <p className="notice">{t('ai.unpriced')}</p>}
    <details><summary>{t('ai.localExecution')}</summary>
      <p className="notice">{t(data.sandbox.qualified ? 'ai.sandboxQualified' : 'ai.sandboxUnqualified')}</p>
      {data.sandbox.reasons.length > 0 && <ul className="help">{data.sandbox.reasons.map((reason, index) => <li key={index}>{t(`ai.reasons.${reason}`, { defaultValue: t('ai.sandboxReason', { reason }) })}</li>)}</ul>}
      <p className="help">{t('ai.resourceGate')}</p>
    </details>
    <section className="log-line" aria-labelledby="ai-credentials"><h2 id="ai-credentials">{t('ai.credentials')}</h2><p className="help">{t('ai.credentialsHelp')}</p>
      {data.credentials.length ? <ul className="help">{data.credentials.map(credential => <li key={credential.ref}><code>{credential.ref}</code>: {t(credential.hasValue ? 'ai.present' : 'ai.absent')} ({t(`ai.${credential.source}`)})</li>)}</ul> : <p className="help">{t('ai.noCredentials')}</p>}
      <form noValidate autoComplete="off" onSubmit={event => {
        event.preventDefault();
        const value = secret.current?.value ?? '';
        if (secret.current) secret.current.value = '';
        setSecretDirty(false);
        if (locked || setupDirty || settingsDirty || extensionDirty) return;
        const parsed = aiCredentialChangeSchema.safeParse({ operation: 'replace', ref, value });
        if (!parsed.success || !ref.startsWith('vault:')) { setError('INVALID_INPUT'); return; }
        void mutate('/api/ai/credentials', 'POST', { revision: data.revision, change: parsed.data }).catch(() => {});
      }}>
        <fieldset disabled={locked || setupDirty || settingsDirty || extensionDirty}>
          <div className="schema-field"><label htmlFor="ai-credential-ref">{t('ai.credentialRef')}</label><input id="ai-credential-ref" value={ref} placeholder="vault:provider" autoComplete="off" onChange={event => setRef(event.target.value)} /></div>
          <div className="schema-field"><label htmlFor="ai-credential-value">{t('ai.credentialValue')}</label><input ref={secret} id="ai-credential-value" type="password" maxLength={16_384} autoComplete="new-password" aria-describedby="ai-secret-help" onChange={event => setSecretDirty(Boolean(event.target.value))} /><p id="ai-secret-help" className="help">{t('ai.writeOnly')}</p></div>
          <div className="button-row"><button type="button" className="danger-text" disabled={!vaultRefValid} onClick={() => { if (secret.current) secret.current.value = ''; setSecretDirty(false); setIntent('delete'); }}>{t('ai.deleteCredential')}</button><button className="primary" disabled={!secretDirty || !vaultRefValid}>{t('ai.replaceCredential')}</button></div>
        </fieldset>
      </form>
      {settingsDirty && <p className="help">{t('ai.saveSettingsFirst')}</p>}
    </section>
    <AiExtensionPanel key={`extensions-${data.revision}-${version}`} settings={data.settings} available={data.status.available} disabled={busy || Boolean(pending) || blocked || setupDirty || settingsDirty}
      onDirty={setExtensionDirty} onBusy={setExtensionBusy} onRequest={() => { if (secret.current) secret.current.value = ''; setSecretDirty(false); }} onReload={() => setIntent('reload')}
      onActivate={settings => mutate('/api/ai/admin', 'PUT', { revision: data.revision, settings })} />
    {extensionDirty && <p className="notice">{t('ai.extensions.finishDraft')}</p>}
    <section aria-labelledby="ai-settings"><h2 id="ai-settings">{t('ai.settings')}</h2><p className="notice">{t('ai.invalidation')}</p>
      <fieldset disabled={locked || setupDirty || extensionDirty}>
        <AiSettingsForm key={`${data.revision}-${version}`} settings={data.settings} tools={{ catalog: toolCatalog, loading: toolsLoading, error: toolsError,
          searchConfigured: searchReadiness === 'configured' || searchReadiness === 'noTools', localQualified: data.sandbox.qualified,
          reload: () => setToolsVersion(value => value + 1) }} onDirty={setSettingsDirty}
          onSave={settings => mutate('/api/ai/admin', 'PUT', { revision: data.revision, settings })} />
      </fieldset>
    </section>
    </Suspense>}
    </details>
    {intent && <ConfirmDialog title={t(intent === 'reload' ? 'state.leaveTitle' : intent === 'disable' ? 'ai.disableTitle' : 'ai.deleteTitle')} danger={intent !== 'reload'} confirm={t(intent === 'reload' ? 'state.reload' : intent === 'disable' ? 'ai.disable' : 'ai.deleteCredential')} onCancel={() => setIntent(undefined)} onConfirm={() => {
      const operation = intent; setIntent(undefined);
      if (operation === 'reload') reload();
      else void mutate(operation === 'disable' ? '/api/ai/disable' : '/api/ai/credentials', 'POST', operation === 'disable' ? { revision: data.revision } : { revision: data.revision, change: { operation: 'delete', ref } }).catch(() => {});
    }}><p>{t(intent === 'reload' ? 'state.reloadHelp' : intent === 'disable' ? 'ai.disableHelp' : 'ai.deleteHelp')}</p>{intent !== 'reload' && <p>{t('ai.invalidation')}</p>}{(setupDirty || settingsDirty || extensionDirty) && <p>{t('state.leaveHelp')}</p>}</ConfirmDialog>}
    {pending && <ConfirmDialog title={t('ai.confirmTitle')} danger busy={busy} onCancel={() => { pending.reject(new ApiError('CANCELLED')); setPending(undefined); }} onConfirm={() => {
      if (busy) return;
      setBusy(true);
      void query<unknown>('/api/confirm', 'POST', { token: pending.confirmation.token }).then(value => { accept(value); pending.resolve(); })
        .catch((failure: unknown) => pending.reject(failure instanceof ApiError ? failure : new ApiError(errorCode(failure))))
        .finally(() => { setPending(undefined); setBusy(false); });
    }}><p>{t('ai.invalidation')}</p><p>{t('ai.confirmHelp')}</p></ConfirmDialog>}
  </div>;
}
