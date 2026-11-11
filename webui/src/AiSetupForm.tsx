import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { groupPageSchema, type GroupPage } from '../../shared/schemas';
import { aiProtocolSchema, type AiProtocol } from '../../shared/schemas/ai';
import { aiPersonalSetupSchema, type AiPersonalSetup } from '../../shared/schemas/ai-admin';
import { errorCode, query } from './api';

const services = {
  openai: { protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1' },
  google: { protocol: 'google-generate-content', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  deepseek: { protocol: 'openai-chat-completions', baseUrl: 'https://api.deepseek.com/v1' },
  custom: { protocol: 'openai-chat-completions', baseUrl: '' },
} as const;

export function AiSetupForm({ revision, disabled, clearSensitive, onDirty, onSave }: {
  revision: number; disabled: boolean; clearSensitive: boolean;
  onDirty(dirty: boolean): void; onSave(input: AiPersonalSetup): Promise<void>;
}) {
  const { t } = useTranslation();
  const [service, setService] = useState<keyof typeof services>('openai');
  const [protocol, setProtocol] = useState<AiProtocol>(services.openai.protocol);
  const [baseUrl, setBaseUrl] = useState<string>(services.openai.baseUrl);
  const [model, setModel] = useState('');
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [groups, setGroups] = useState<GroupPage>();
  const [groupsError, setGroupsError] = useState<string>();
  const [secretDirty, setSecretDirty] = useState(false);
  const [invalid, setInvalid] = useState<string[]>([]);
  const secret = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const dirty = Boolean(model || secretDirty || groupIds.length || service !== 'openai'
    || protocol !== services.openai.protocol || baseUrl !== services.openai.baseUrl);

  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    if (clearSensitive) { if (secret.current) secret.current.value = ''; setSecretDirty(false); }
  }, [clearSensitive]);
  useEffect(() => {
    const input = secret.current;
    const clear = () => { if (input) input.value = ''; setSecretDirty(false); };
    window.addEventListener('pagehide', clear);
    return () => { if (input) input.value = ''; window.removeEventListener('pagehide', clear); };
  }, []);
  useEffect(() => {
    if (!groupsOpen) return;
    let current = true;
    setGroups(undefined); setGroupsError(undefined);
    void query<unknown>(`/api/groups?page=${page}`).then(value => groupPageSchema.parse(value))
      .then(value => { if (current) setGroups(value); })
      .catch((failure: unknown) => { if (current) setGroupsError(errorCode(failure)); });
    return () => { current = false; };
  }, [groupsOpen, page]);

  function choose(value: keyof typeof services) {
    setService(value); setProtocol(services[value].protocol); setBaseUrl(services[value].baseUrl);
    if (secret.current) secret.current.value = '';
    setSecretDirty(false); setInvalid([]);
  }
  return <section aria-labelledby="ai-setup-title">
    <h2 id="ai-setup-title">{t('ai.setup.title')}</h2><p className="help">{t('ai.setup.help')}</p>
    <form noValidate autoComplete="off" onSubmit={event => {
      event.preventDefault();
      if (disabled || sending.current) return;
      const apiKey = secret.current?.value ?? '';
      if (secret.current) secret.current.value = '';
      setSecretDirty(false);
      const parsed = aiPersonalSetupSchema.safeParse({ revision, protocol, baseUrl, model, apiKey, groupIds });
      if (!parsed.success) { setInvalid([...new Set(parsed.error.issues.map(issue => String(issue.path[0] ?? 'model')))]); return; }
      setInvalid([]); sending.current = true;
      void onSave(parsed.data).catch(() => {}).finally(() => { sending.current = false; });
    }}>
      <fieldset disabled={disabled}>
        <div className="schema-field"><label htmlFor="ai-setup-service">{t('ai.setup.service')}</label>
          <select id="ai-setup-service" value={service} onChange={event => choose(event.target.value as keyof typeof services)}>
            {(Object.keys(services) as (keyof typeof services)[]).map(value => <option key={value} value={value}>{t(`ai.setup.services.${value}`)}</option>)}
          </select></div>
        <p className="help">{t('ai.setup.destination')} <code style={{ overflowWrap: 'anywhere' }}>{baseUrl || t('state.noValue')}</code></p>
        <details open={service === 'custom' ? true : undefined}><summary>{t('ai.setup.customize')}</summary>
          <div className="schema-field"><label htmlFor="ai-setup-protocol">{t('ai.fields.protocol')}</label><select id="ai-setup-protocol" value={protocol} onChange={event => { setProtocol(event.target.value as AiProtocol); setInvalid([]); }}>{aiProtocolSchema.options.map(value => <option key={value} value={value}>{t(`ai.options.${value}`)}</option>)}</select></div>
          <div className="schema-field"><label htmlFor="ai-setup-url">{t('ai.fields.baseUrl')}</label><input id="ai-setup-url" type="url" value={baseUrl} maxLength={2048} onChange={event => { setBaseUrl(event.target.value); setInvalid([]); }} /></div>
        </details>
        <div className="schema-field"><label htmlFor="ai-setup-key">{t('ai.setup.apiKey')}</label><input ref={secret} id="ai-setup-key" type="password" maxLength={16_384} autoComplete="new-password" aria-describedby="ai-setup-key-help" onChange={event => { setSecretDirty(Boolean(event.target.value)); setInvalid([]); }} /><p id="ai-setup-key-help" className="help">{t('ai.writeOnly')}</p></div>
        <div className="schema-field"><label htmlFor="ai-setup-model">{t('ai.setup.model')}</label><input id="ai-setup-model" value={model} maxLength={256} onChange={event => { setModel(event.target.value); setInvalid([]); }} /><p className="help">{t('ai.setup.modelHelp')}</p></div>
        <details onToggle={event => { if (event.currentTarget.open) setGroupsOpen(true); }}><summary>{t('ai.setup.groups')}</summary>
          <p className="help">{t('ai.setup.groupsHelp')}</p>
          {groupsError ? <p role="alert" className="notice error">{t(`common:errors.${groupsError}`)}</p> : groupsOpen && !groups ? <p role="status">{t('state.loading')}</p> : null}
          {groups && <>{groups.items.length ? groups.items.map(group => <div className="schema-field" key={group.id}>
            <label><input type="checkbox" checked={groupIds.includes(group.id)} onChange={event => setGroupIds(current => event.target.checked ? [...current, group.id] : current.filter(id => id !== group.id))} /> {group.title || t('groups.unknownTitle')} <span className="mono help">{group.id}</span></label>
          </div>) : <p className="help">{t('groups.empty')}</p>}
            <div className="button-row"><button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>{t('common:actions.previous')}</button><span className="help">{t('groups.page', { page: page + 1, pages: Math.max(1, Math.ceil(groups.total / groups.pageSize)) })}</span><button type="button" disabled={(page + 1) * groups.pageSize >= groups.total} onClick={() => setPage(value => value + 1)}>{t('common:actions.next')}</button></div>
          </>}
          <p className="help">{t('ai.setup.selectedGroups', { total: groupIds.length })}</p>
        </details>
        <p className="notice">{t('ai.setup.budgetHelp')}</p><p className="help">{t('ai.setup.consent')}</p>
        {invalid.length > 0 && <p role="alert" className="notice error">{t('state.validation')} {invalid.map(field => t(`ai.setup.validation.${field}`, { defaultValue: t('state.fieldError') })).join(', ')}</p>}
        <div className="button-row"><button type="button" disabled={!dirty} onClick={() => { choose('openai'); setModel(''); setGroupIds([]); }}>{t('ai.setup.reset')}</button><button type="submit" className="primary" disabled={!model || !secretDirty || !baseUrl}>{t('ai.setup.save')}</button></div>
      </fieldset>
    </form>
  </section>;
}
