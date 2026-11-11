import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import type { Confirmation } from '../../shared/schemas';
import { aiSettingsSchema, type AiSettings } from '../../shared/schemas/ai';
import {
  aiExtensionStatusSchema, aiSkillInstallSchema, aiSkillReviewSchema, aiSkillReviewResultSchema,
  aiMcpReviewInputSchema, aiSandboxReviewInputSchema, aiMcpDiscoveryResultSchema, aiSandboxReviewResultSchema, type AiExtensionScope,
  aiLocalSandboxReviewInputSchema, aiLocalSandboxReviewResultSchema, aiLocalSandboxProbeResultSchema, aiStdioMcpReviewInputSchema,
  aiSkillSettingSchema, aiMcpSettingSchema, aiSandboxProfileSchema, aiLocalSandboxProfileSchema, aiStdioMcpProfileSchema,
} from '../../shared/schemas/ai-extensions';
import { action, ApiError, errorCode, query } from './api';
import { AiSchemaForm } from './AiSettingsForm';
import { ConfirmDialog } from './ConfirmDialog';

const workflows = {
  install: { path: 'skills/install', actionId: 'ai.skills.install', schema: aiSkillInstallSchema, write: true },
  skill: { path: 'skills/review', actionId: 'ai.skills.review', schema: aiSkillReviewSchema, write: false },
  mcp: { path: 'mcp/discover', actionId: 'ai.mcp.discover', schema: aiMcpReviewInputSchema, write: true },
  sandbox: { path: 'sandbox/review', actionId: 'ai.sandbox.review', schema: aiSandboxReviewInputSchema, write: false },
  local: { path: 'sandbox/local/review', actionId: 'ai.sandbox.local.review', schema: aiLocalSandboxReviewInputSchema, write: false },
  probe: { path: 'sandbox/local/probe', actionId: 'ai.sandbox.local.probe', schema: z.strictObject({}), write: false },
  stdio: { path: 'mcp/stdio/discover', actionId: 'ai.mcp.stdio.discover', schema: aiStdioMcpReviewInputSchema, write: true },
};
type Kind = keyof typeof workflows;
type Proposal = { kind: Kind; body: Record<string, unknown> };
type Review = { proposal: Proposal; result: z.infer<typeof aiSkillReviewResultSchema> | z.infer<typeof aiMcpDiscoveryResultSchema> | z.infer<typeof aiSandboxReviewResultSchema> | z.infer<typeof aiLocalSandboxReviewResultSchema> };

function replaceProfile<T extends { id: string }>(items: T[] | undefined, profile: T): T[] {
  return items?.some(item => item.id === profile.id) ? items.map(item => item.id === profile.id ? profile : item) : [...items ?? [], profile];
}

function blank(kind: Kind): Record<string, unknown> {
  if (kind === 'install') return { id: '', files: [{ path: 'SKILL.md', text: '' }], tools: [], scopes: [] };
  if (kind === 'skill') return { id: '', digest: '' };
  if (kind === 'probe') return {};
  if (kind === 'local' || kind === 'stdio') return { profile: { enabled: false, runtime: 'node', ...(kind === 'stdio' ? { tools: [], readTools: [], bundle: { args: [], inputs: [] } } : {}) } };
  return { profile: { enabled: false, credentialAuthority: 'service', ...(kind === 'mcp' ? { tools: [], readTools: [] } : {}) } };
}
function Literal({ value }: { value: unknown }) {
  return <pre className="mono" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '20rem', overflow: 'auto', fontSize: '.8rem' }}>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}
function Scopes({ scopes }: { scopes: readonly AiExtensionScope[] }) {
  const { t } = useTranslation();
  return <div>{scopes.map((scope, index) => <dl className="effective-values" key={index}>
    <div><dt>{t('ai.fields.botId')}</dt><dd>{scope.botId}</dd></div>
    <div><dt>{t('ai.fields.ownerId')}</dt><dd>{scope.ownerId}</dd></div>
    <div><dt>{t('ai.fields.audience')}</dt><dd>{t(`ai.options.${scope.audience.kind}`)}: {scope.audience.kind === 'private' ? scope.audience.userId : scope.audience.chatId}</dd></div>
    <div><dt>{t('ai.fields.threadId')}</dt><dd>{scope.audience.threadId ?? t('ai.extensions.noTopic')}</dd></div>
  </dl>)}</div>;
}
function Preview({ proposal }: { proposal: Proposal }) {
  const { t } = useTranslation();
  if (proposal.kind === 'install') {
    const body = aiSkillInstallSchema.parse(proposal.body);
    return <><p><strong>{t('ai.fields.id')}:</strong> {body.id}</p><Scopes scopes={body.scopes} /><p>{t('ai.fields.tools')}: {body.tools.join(', ') || t('ai.extensions.none')}</p>
      {body.files.map(file => <details key={file.path} open><summary><code>{file.path}</code></summary><Literal value={file.text} /></details>)}</>;
  }
  if (proposal.kind === 'skill') return <Literal value={proposal.body} />;
  if (proposal.kind === 'probe') return <><p>{t('ai.extensions.probeHelp')}</p><Literal value={proposal.body} /></>;
  if (proposal.kind === 'local' || proposal.kind === 'stdio') {
    const profile = proposal.kind === 'local' ? aiLocalSandboxReviewInputSchema.parse(proposal.body).profile : aiStdioMcpReviewInputSchema.parse(proposal.body).profile;
    return <><p>{t(proposal.kind === 'local' ? 'ai.extensions.localReviewHelp' : 'ai.extensions.stdioApproval')}</p>{profile.scope && <Scopes scopes={[profile.scope]} />}
      <details open><summary>{t('ai.extensions.fullProfile')}</summary><Literal value={profile} /></details></>;
  }
  const profile = proposal.kind === 'mcp' ? aiMcpReviewInputSchema.parse(proposal.body).profile : aiSandboxReviewInputSchema.parse(proposal.body).profile;
  return <><p><strong>{t('ai.fields.endpoint')}:</strong> <span style={{ overflowWrap: 'anywhere' }}>{profile.endpoint}</span></p>
    <p>{t('ai.fields.credentialAuthority')}: {t(`ai.options.${profile.credentialAuthority}`)}<br />{t('ai.fields.credentialRef')}: <code>{profile.credentialRef ?? t('ai.extensions.none')}</code></p>
    {profile.scope && <Scopes scopes={[profile.scope]} />}<details><summary>{t('ai.extensions.fullProfile')}</summary><Literal value={profile} /></details></>;
}

export function AiExtensionPanel({ settings, available, disabled, onDirty, onBusy, onRequest, onReload, onActivate }: {
  settings: AiSettings; available: boolean; disabled: boolean; onDirty(dirty: boolean): void;
  onBusy(busy: boolean): void; onRequest(): void; onReload(): void;
  onActivate(settings: AiSettings): Promise<void>;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<z.infer<typeof aiExtensionStatusSchema>>();
  const [version, setVersion] = useState(0);
  const [kind, setKind] = useState<Kind>('install');
  const [initial, setInitial] = useState(() => blank('install'));
  const [formKey, setFormKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string>();
  const [sizeError, setSizeError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [pending, setPending] = useState<{ proposal: Proposal; confirmation: Confirmation }>();
  const [review, setReview] = useState<Review>();
  const [probe, setProbe] = useState<z.infer<typeof aiLocalSandboxProbeResultSchema>>();
  const [replacement, setReplacement] = useState<{ kind: Kind; initial: Record<string, unknown> }>();
  const [selected, setSelected] = useState('');
  const [opened, setOpened] = useState(false);
  const mounted = useRef(true);
  const sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { onBusy(busy || Boolean(pending)); return () => { onBusy(false); }; }, [busy, pending, onBusy]);
  useEffect(() => {
    let current = true;
    setStatus(undefined);
    if (available) void query<unknown>('/api/ai/admin/extensions/status').then(value => {
      const parsed = aiExtensionStatusSchema.safeParse(value);
      if (!parsed.success) throw new ApiError('INVALID_OUTPUT');
      if (current) { setStatus(parsed.data); setError(undefined); }
    }).catch((failure: unknown) => { if (current) setError(errorCode(failure)); });
    return () => { current = false; };
  }, [available, version]);

  function reset(next: { kind: Kind; initial: Record<string, unknown> }) {
    setKind(next.kind); setInitial(next.initial); setFormKey(value => value + 1); setDirty(false);
    setReview(undefined); setProbe(undefined); setError(undefined); setSizeError(false); setCopied(false); setCopyFailed(false); setSelected('');
  }
  function failure(value: unknown) {
    if (!mounted.current) return;
    const code = errorCode(value); setError(code);
    if (['CONFLICT', 'OUTCOME_UNKNOWN', 'TIMEOUT', 'UNAVAILABLE', 'INVALID_OUTPUT', 'CONFIRMATION_EXPIRED', 'CSRF_INVALID'].includes(code)) setBlocked(true);
  }
  function receive(value: unknown, submitted: Proposal) {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 262_144) throw new ApiError('INVALID_OUTPUT');
    if (submitted.kind === 'probe') {
      const result = aiLocalSandboxProbeResultSchema.safeParse(value);
      if (!result.success) throw new ApiError('INVALID_OUTPUT');
      if (mounted.current) { setProbe(result.data); setStatus(current => current ? { ...current, ...result.data } : current); setDirty(false); }
      return;
    }
    const output = submitted.kind === 'install' || submitted.kind === 'skill' ? aiSkillReviewResultSchema.safeParse(value)
      : submitted.kind === 'mcp' || submitted.kind === 'stdio' ? aiMcpDiscoveryResultSchema.safeParse(value)
        : submitted.kind === 'local' ? aiLocalSandboxReviewResultSchema.safeParse(value) : aiSandboxReviewResultSchema.safeParse(value);
    if (!output.success) throw new ApiError('INVALID_OUTPUT');
    const expectedId = submitted.kind === 'install' || submitted.kind === 'skill' ? submitted.body.id : (submitted.body.profile as { id: string }).id;
    const actualId = 'id' in output.data ? output.data.id : output.data.profileId;
    if (actualId !== expectedId || submitted.kind === 'skill' && output.data.digest !== submitted.body.digest) throw new ApiError('INVALID_OUTPUT');
    if (mounted.current) { setReview({ proposal: submitted, result: output.data }); setDirty(false); setCopied(false); setCopyFailed(false); }
  }
  async function submit(submitted: Proposal) {
    if (sending.current || disabled || !available || !status || blocked) return;
    sending.current = true; setBusy(true); setError(undefined); setReview(undefined); setProbe(undefined); onRequest();
    try {
      const result = await action<unknown>(`/api/ai/admin/extensions/${workflows[submitted.kind].path}`, 'POST', submitted.body);
      if (result.status === 'pending_confirmation') {
        if (result.confirmation.actionId !== workflows[submitted.kind].actionId) throw new ApiError('INVALID_OUTPUT');
        if (mounted.current) setPending({ proposal: submitted, confirmation: result.confirmation });
      } else if (result.status === 'succeeded' && !workflows[submitted.kind].write) receive(result.data, submitted);
      else throw new ApiError('INVALID_OUTPUT');
    } catch (value) { failure(value); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  const locked = disabled || !available || !status || blocked || busy || Boolean(pending);
  const localReview = review?.proposal.kind === 'local' || review?.proposal.kind === 'stdio';
  async function activateReviewed() {
    if (!review || locked || dirty || sending.current || localReview && !status?.localEnabled) return;
    sending.current = true; setBusy(true); setError(undefined); onRequest();
    try {
      const next = structuredClone(settings);
      const { kind, body } = review.proposal;
      if (kind === 'install' || kind === 'skill') {
        const result = aiSkillReviewResultSchema.parse(review.result);
        next.skills = replaceProfile(next.skills, aiSkillSettingSchema.parse({ id: result.id, digest: result.digest,
          scopes: result.scopes, tools: result.tools, enabled: true }));
      } else if (kind === 'mcp') {
        const profile = aiMcpReviewInputSchema.parse(body).profile;
        next.mcp = replaceProfile(next.mcp, aiMcpSettingSchema.parse({ ...profile, schemaDigest: review.result.digest, enabled: true }));
      } else {
        const sandbox = next.sandbox ?? { enabled: false, profiles: [] };
        // Enabling one reviewed profile must not revive other profiles under a disabled global switch.
        if (!sandbox.enabled) {
          sandbox.profiles = sandbox.profiles.map(profile => ({ ...profile, enabled: false }));
          if (sandbox.localProfiles) sandbox.localProfiles = sandbox.localProfiles.map(profile => ({ ...profile, enabled: false }));
          if (sandbox.stdioProfiles) sandbox.stdioProfiles = sandbox.stdioProfiles.map(profile => ({ ...profile, enabled: false }));
        }
        if (kind === 'sandbox') sandbox.profiles = replaceProfile(sandbox.profiles, aiSandboxProfileSchema.parse({
          ...aiSandboxReviewInputSchema.parse(body).profile, reviewedDigest: review.result.digest, enabled: true }));
        else if (kind === 'local') sandbox.localProfiles = replaceProfile(sandbox.localProfiles, aiLocalSandboxProfileSchema.parse({
          ...aiLocalSandboxReviewInputSchema.parse(body).profile, reviewedDigest: review.result.digest, enabled: true }));
        else if (kind === 'stdio') sandbox.stdioProfiles = replaceProfile(sandbox.stdioProfiles, aiStdioMcpProfileSchema.parse({
          ...aiStdioMcpReviewInputSchema.parse(body).profile, schemaDigest: review.result.digest, enabled: true }));
        else throw new ApiError('INVALID_INPUT');
        sandbox.enabled = true; next.sandbox = sandbox;
      }
      await onActivate(aiSettingsSchema.parse(next));
      if (mounted.current) setReview(undefined);
    } catch (value) { failure(value); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  const profiles = kind === 'mcp' ? settings.mcp ?? [] : kind === 'sandbox' ? settings.sandbox?.profiles ?? [] : kind === 'skill' ? settings.skills ?? []
    : kind === 'local' ? settings.sandbox?.localProfiles ?? [] : kind === 'stdio' ? settings.sandbox?.stdioProfiles ?? [] : [];
  return <section className="log-line" aria-labelledby="ai-extensions-title">
    <h2 id="ai-extensions-title">{t('ai.extensions.title')}</h2>
    <p className="notice">{t('ai.extensions.activation')}</p>
    {available && !status && !error && <p role="status">{t('state.loading')}</p>}
    {status && <><dl className="effective-values">{(['skills', 'mcp', 'remoteExecutors', 'localExecutors', 'stdioMcp'] as const).map(key => <div key={key}><dt>{t(`ai.extensions.counts.${key}`)}</dt><dd>{status[key]}</dd></div>)}</dl><p className="help">{t(status.localEnabled ? 'ai.extensions.localAvailable' : 'ai.extensions.localUnavailable')}</p>{!status.localEnabled && <p className="help">{t(`ai.extensions.reasons.${status.localReason}`, { defaultValue: t('ai.sandboxReason', { reason: status.localReason }) })}</p>}</>}
    <button type="button" disabled={locked || dirty} onClick={() => { void submit({ kind: 'probe', body: {} }); }}>{t('ai.extensions.probeButton')}</button>
    {probe && <section aria-labelledby="ai-local-probe-result"><h3 id="ai-local-probe-result">{t('ai.extensions.probeResult')}</h3><p role="status" className="notice">{t(probe.localEnabled ? 'ai.extensions.probeQualified' : 'ai.extensions.probeUnqualified')}</p><Literal value={probe} /></section>}
    {error && <div role="alert" className="notice error"><p>{t(`common:errors.${error}`)}</p>{blocked ? <><p>{t('ai.refreshRequired')}</p><button type="button" onClick={onReload}>{t('state.reload')}</button></> : !status && available ? <button type="button" onClick={() => setVersion(value => value + 1)}>{t('common:actions.retry')}</button> : null}</div>}
    {sizeError && <p role="alert" className="error-text">{t('ai.extensions.bodyLimit')}</p>}
    <details onToggle={event => { if (event.currentTarget.open) setOpened(true); }}><summary>{t('ai.extensions.open')}</summary><p className="help">{t('ai.extensions.bodyLimit')}</p>
      {opened && <fieldset disabled={locked}>
        <div className="schema-field"><label htmlFor="ai-extension-kind">{t('ai.extensions.workflow')}</label><select id="ai-extension-kind" value={kind} onChange={event => {
          const next = event.target.value as Kind; const value = { kind: next, initial: blank(next) };
          if (dirty) setReplacement(value); else reset(value);
        }}>{(Object.keys(workflows) as Kind[]).map(value => <option value={value} key={value}>{t(`ai.extensions.workflows.${value}`)}</option>)}</select></div>
        {profiles.length > 0 && <div className="schema-field"><label htmlFor="ai-extension-profile">{t('ai.extensions.savedProfile')}</label><select id="ai-extension-profile" value={selected} onChange={event => setSelected(event.target.value)}><option value="">{t('ai.extensions.chooseProfile')}</option>{profiles.map(profile => <option value={profile.id} key={profile.id}>{profile.id}</option>)}</select><button type="button" disabled={!selected} onClick={() => {
          const profile = profiles.find(value => value.id === selected); if (!profile) return;
          const next = { kind, initial: kind === 'skill' && 'digest' in profile ? { id: profile.id, digest: profile.digest } : { profile: structuredClone(profile) } };
          if (dirty) setReplacement(next); else reset(next);
        }}>{t('ai.extensions.loadProfile')}</button></div>}
        <AiSchemaForm key={formKey} contract={workflows[kind].schema as z.ZodType<Record<string, unknown>>} initialValue={initial} idPrefix="extension" submitKey="ai.extensions.preview" requireDirty={false} clearDirtyOnSubmit={false} onDirty={value => { if (locked) return; setDirty(value); if (value) { setReview(undefined); setProbe(undefined); setCopied(false); } }} onSave={async body => {
          if (locked) return;
          setSizeError(false); setReview(undefined); setError(undefined);
          if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 32_768) { setSizeError(true); return; }
          if (['mcp', 'sandbox', 'local', 'stdio'].includes(kind) && !(body.profile as { scope?: unknown }).scope) { setError('INVALID_INPUT'); return; }
          await submit({ kind, body });
        }} />
      </fieldset>}
      {review && <section aria-labelledby="ai-extension-result"><h3 id="ai-extension-result">{t('ai.extensions.result')}</h3><p className="notice">{t('ai.extensions.untrusted')}</p>
        <div className="schema-field"><label htmlFor="ai-review-digest">{t('ai.fields.digest')}</label><input id="ai-review-digest" className="mono" readOnly value={review.result.digest} onFocus={event => event.target.select()} /></div>
        <button type="button" onClick={async () => { setCopyFailed(false); try { await navigator.clipboard.writeText(review.result.digest); setCopied(true); } catch { setCopyFailed(true); } }}>{t('ai.extensions.copyDigest')}</button>
        {copied && <p role="status" className="help">{t('ai.extensions.copied')}</p>}{copyFailed && <p role="status" className="help">{t('ai.extensions.copyFallback')}</p>}
        <p className="help">{t('ai.extensions.activation')}</p>{review.proposal.kind === 'install' || review.proposal.kind === 'skill' ? <details><summary>{t('ai.extensions.submitted')}</summary><Preview proposal={review.proposal} /></details> : <><h4>{t('ai.extensions.submitted')}</h4><Preview proposal={review.proposal} /></>}
        {'manifest' in review.result ? <><Scopes scopes={review.result.scopes} /><h4>{review.result.name}</h4><Literal value={review.result.description} /><h4>{t('ai.extensions.manifest')}</h4>{review.result.manifest.map(file => <p className="help" style={{ overflowWrap: 'anywhere' }} key={file.path}><code>{file.path}</code><br /><code>{file.sha256}</code></p>)}<Literal value={review.result.body} /><h4>{t('ai.extensions.declaredTools')}</h4><Literal value={review.result.declaredTools} /><h4>{t('ai.fields.tools')}</h4><Literal value={review.result.tools} /></>
          : 'tools' in review.result ? <><h4>{t('ai.extensions.toolSchemas')}</h4>{review.result.tools.map(item => <details key={item.name} open><summary>{item.name}</summary><Literal value={item} /></details>)}<h4>{t('ai.extensions.discovery')}</h4><Literal value={review.result.review} /></>
            : <><p className="notice">{t('policyHash' in review.result ? 'ai.extensions.localReviewHelp' : 'ai.extensions.notQualification')}</p><Literal value={review.result} /></>}
        {localReview && !status?.localEnabled && <p className="notice">{t('ai.extensions.activationNeedsQualification')}</p>}
        <button type="button" className="primary" disabled={locked || dirty || localReview && !status?.localEnabled} onClick={() => { void activateReviewed(); }}>{t('ai.extensions.activate')}</button>
      </section>}
    </details>
    {replacement && <ConfirmDialog title={t('state.leaveTitle')} onCancel={() => setReplacement(undefined)} onConfirm={() => { reset(replacement); setReplacement(undefined); }}><p>{t('state.leaveHelp')}</p></ConfirmDialog>}
    {pending && <ConfirmDialog title={t('ai.extensions.approveTitle')} danger busy={busy} onCancel={() => setPending(undefined)} onConfirm={() => {
      if (sending.current) return;
      sending.current = true; setBusy(true);
      const submitted = pending;
      void query<unknown>('/api/confirm', 'POST', { token: submitted.confirmation.token }).then(value => receive(value, submitted.proposal)).catch((value: unknown) => failure(value))
        .finally(() => { sending.current = false; if (mounted.current) { setPending(undefined); setBusy(false); } });
    }}><p>{t(pending.proposal.kind === 'mcp' ? 'ai.extensions.credentialTransfer' : pending.proposal.kind === 'stdio' ? 'ai.extensions.stdioApproval' : 'ai.extensions.installApproval')}</p><p>{t('ai.confirmHelp')}</p><div style={{ maxHeight: '45vh', overflow: 'auto' }}><Preview proposal={pending.proposal} /></div></ConfirmDialog>}
  </section>;
}
