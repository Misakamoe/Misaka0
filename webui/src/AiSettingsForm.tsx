import { useEffect, useRef, useState } from 'react';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { TranslatableString, type ArrayFieldItemTemplateProps, type FieldTemplateProps, type IconButtonProps, type OptionalDataControlsTemplateProps, type RJSFSchema, type UiSchema, type WidgetProps } from '@rjsf/utils';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { inputJsonSchema } from '../../shared/schemas';
import { aiSettingsSchema, type AiSettings } from '../../shared/schemas/ai';
import { errorCode } from './api';

function Field({ id, label, displayLabel, required, children, description, errors, rawErrors, schema }: FieldTemplateProps) {
  const { t } = useTranslation();
  const union = (['oneOf', 'anyOf'] as const).find(kind => schema[kind]?.some(branch => typeof branch === 'object' && (branch.type === 'object' || branch.properties)));
  const inputId = union ? `${id}__${union.toLowerCase()}_select` : id;
  return <div className={`schema-field${rawErrors?.length ? ' has-error' : ''}`}>
    {displayLabel && <div className="field-label"><label htmlFor={inputId}>{label}</label>{required && <span className="help">{t('state.required')}</span>}</div>}
    {displayLabel && description}{children}{errors}
  </div>;
}
function Button({ label, id, onClick, disabled }: IconButtonProps & { label: string }) {
  const { t } = useTranslation();
  return <button type="button" id={id} onClick={onClick} disabled={disabled} aria-label={t(label)}>{t(label)}</button>;
}
const buttons = {
  AddButton: (props: IconButtonProps) => <Button {...props} label="common:actions.add" />,
  RemoveButton: (props: IconButtonProps) => <Button {...props} label="common:actions.remove" />,
  MoveUpButton: (props: IconButtonProps) => <Button {...props} label="common:actions.moveUp" />,
  MoveDownButton: (props: IconButtonProps) => <Button {...props} label="common:actions.moveDown" />,
};
function ArrayItem({ children, buttonsProps, hasToolbar, registry }: ArrayFieldItemTemplateProps) {
  const Controls = registry.templates.ArrayFieldItemButtonsTemplate;
  return <div className="array-row"><div className="array-row-fields">{children}</div>{hasToolbar && <div className="array-row-tools"><Controls {...buttonsProps} /></div>}</div>;
}
function OptionalData({ id, onAddClick, onRemoveClick }: OptionalDataControlsTemplateProps) {
  const { t } = useTranslation();
  return <button id={id} type="button" onClick={onAddClick ?? onRemoveClick}>{t(onAddClick ? 'form.optionalAdd' : 'form.optionalRemove')}</button>;
}
function TextFile({ id, value, onChange, disabled, readonly, required }: WidgetProps) {
  const { t } = useTranslation();
  const [invalid, setInvalid] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <div>
    <textarea id={id} rows={8} value={typeof value === 'string' ? value : ''} required={required} disabled={disabled} readOnly={readonly} maxLength={32_768} onChange={event => { setInvalid(false); onChange(event.target.value); }} />
    <label htmlFor={`${id}-upload`} className="help">{t('ai.extensions.upload')}</label>
    <input id={`${id}-upload`} type="file" accept=".md,.txt,.json,.yaml,.yml,.js,.ts,.py,.toml,.csv" disabled={disabled || readonly} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; setInvalid(false);
      if (!file) return;
      if (file.size > 32_768) { setInvalid(true); return; }
      void file.arrayBuffer().then(bytes => {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        for (const character of text) if (character.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(character)) throw new Error('INVALID_INPUT');
        if (mounted.current) onChange(text);
      }).catch(() => { if (mounted.current) setInvalid(true); });
    }} />
    {invalid && <p role="alert" className="error-text">{t('ai.extensions.fileError')}</p>}
  </div>;
}
const strings: Partial<Record<TranslatableString, string>> = {
  [TranslatableString.ArrayItemTitle]: 'form.item', [TranslatableString.EmptyArray]: 'form.emptyArray',
  [TranslatableString.YesLabel]: 'common:yes', [TranslatableString.NoLabel]: 'common:no',
  [TranslatableString.OptionalObjectAdd]: 'form.optionalAdd', [TranslatableString.OptionalObjectRemove]: 'form.optionalRemove',
  [TranslatableString.OptionalObjectEmptyMsg]: 'form.optionalEmpty', [TranslatableString.AddButton]: 'common:actions.add',
  [TranslatableString.AddItemButton]: 'common:actions.add', [TranslatableString.RemoveButton]: 'common:actions.remove',
  [TranslatableString.MoveUpButton]: 'common:actions.moveUp', [TranslatableString.MoveDownButton]: 'common:actions.moveDown',
  [TranslatableString.ErrorsLabel]: 'form.errors', [TranslatableString.Type]: 'form.type', [TranslatableString.Value]: 'form.value',
};

export function AiSettingsForm({ settings, onSave, onDirty }: {
  settings: AiSettings; onSave(settings: AiSettings): Promise<void>; onDirty(dirty: boolean): void;
}) {
  return <AiSchemaForm contract={aiSettingsSchema} initialValue={settings} onSave={onSave} onDirty={onDirty} />;
}

export function AiSchemaForm<T extends Record<string, unknown>>({ contract, initialValue, onSave, onDirty, idPrefix = 'root', submitKey = 'common:actions.save', requireDirty = true, clearDirtyOnSubmit = true }: {
  contract: z.ZodType<T>; initialValue: Record<string, unknown>; onSave(value: T): Promise<void>;
  onDirty(dirty: boolean): void; idPrefix?: string; submitKey?: string; requireDirty?: boolean; clearDirtyOnSubmit?: boolean;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<Record<string, unknown>>(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [invalid, setInvalid] = useState(false);
  const [invalidFields, setInvalidFields] = useState<string[]>([]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = JSON.stringify(value) !== JSON.stringify(initialValue);
  function localize(source: RJSFSchema, name = '', path = ''): [RJSFSchema, UiSchema] {
    const schema = structuredClone(source);
    const ui: UiSchema = {};
    for (const kind of ['oneOf', 'anyOf'] as const) if (schema[kind]) schema[kind] = schema[kind].map(branch => {
      if (typeof branch !== 'object') return branch;
      const [next, branchUi] = localize(branch, name, path);
      const discriminator = branch.properties?.kind;
      if (typeof discriminator === 'object' && typeof discriminator.const === 'string') next.title = t(`ai.options.${discriminator.const}`);
      Object.assign(ui, branchUi);
      return next;
    });
    const label = name === 'sandbox' ? 'executors' : name === 'limits' && (path.startsWith('sandbox.') || path === 'profile.limits') ? 'executionLimits' : name;
    if (label) schema.title = t(`ai.fields.${label}`);
    if (!path.endsWith('.*') && ['providers', 'presets', 'grants', 'deniedUserIds', 'limits', 'search', 'skills', 'mcp', 'sandbox', 'credentialRef', 'allowedOrigins', 'tools', 'budget', 'expiresAt', 'system', 'inputCapabilities', 'outputCapabilities', 'pricing', 'retention', 'scope', 'scopes', 'credentialAuthority', 'readTools', 'profiles', 'reviewedDigest', 'localProfiles', 'stdioProfiles', 'files'].includes(name)) schema.description = t(`ai.help.${label}`);
    if (name === 'system') ui['ui:widget'] = 'textarea';
    if (name === 'text' && path.startsWith('files.')) ui['ui:widget'] = 'TextFile';
    if (name === 'expiresAt') ui['ui:widget'] = 'text';
    if (name === 'enabled') schema.default = false;
    if (schema.const !== undefined) {
      if (name === 'currency' || name === 'kind' || name === 'runtime') { schema.oneOf = [{ const: schema.const, title: name === 'currency' ? String(schema.const) : name === 'runtime' ? t('ai.extensions.nodeRuntime') : t(`ai.options.${String(schema.const)}`) }]; delete schema.const; }
      else ui['ui:readonly'] = true;
    }
    if (schema.enum) {
      schema.oneOf = schema.enum.map(item => ({ const: item, title: t(`ai.options.${String(item)}`) }));
      delete schema.enum;
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (typeof child === 'object') {
      const [next, nextUi] = localize(child, key, path ? `${path}.${key}` : key);
      schema.properties![key] = next; ui[key] = nextUi;
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      const [next, nextUi] = localize(schema.items, name, `${path}.*`); schema.items = next; ui.items = nextUi;
    }
    return [schema, ui];
  }
  const [schema, ui] = localize(inputJsonSchema(contract) as RJSFSchema);
  ui['ui:globalOptions'] = { enableOptionalDataFieldForType: ['object', 'array'] };
  return <div className="schema-editor">
    {invalid && <div role="alert" className="error-text"><p>{t('state.validation')}</p>{invalidFields.length > 0 && <ul>{invalidFields.map((field, index) => <li key={index}>{field}</li>)}</ul>}</div>}
    {error && <p role="alert" className="notice error">{t(`common:errors.${error}`)}</p>}
    <Form schema={schema} uiSchema={ui} validator={validator} formData={value} disabled={busy} noHtml5Validate showErrorList={false} idPrefix={idPrefix} widgets={{ TextFile }}
      experimental_defaultFormStateBehavior={{ emptyObjectFields: 'populateRequiredDefaults', arrayMinItems: { populate: 'requiredOnly' }, constAsDefaults: 'never' }}
      templates={{ FieldTemplate: Field, ArrayFieldItemTemplate: ArrayItem, OptionalDataControlsTemplate: OptionalData, ButtonTemplates: buttons, DescriptionFieldTemplate: ({ id, description }) => description ? <p id={id} className="help">{description}</p> : null }}
      translateString={(key, params) => key === TranslatableString.OptionPrefix || key === TranslatableString.TitleOptionPrefix ? t('form.option', { index: params?.at(-1) }) : t(strings[key] ?? 'form.unsupported')}
      transformErrors={errors => errors.map(item => ({ ...item, message: t(`form.${['required', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern', 'uniqueItems'].includes(item.name ?? '') ? item.name : 'invalid'}`, { limit: item.params?.limit }) }))}
      onError={() => { setInvalidFields([]); setInvalid(true); }} onChange={event => { const next = event.formData ?? {}; setValue(next); setError(undefined); setInvalid(false); setInvalidFields([]); onDirty(JSON.stringify(next) !== JSON.stringify(initialValue)); }}
      onSubmit={async () => {
        if (busy) return;
        setError(undefined); setInvalid(false);
        // RJSF leaves undefined properties when switching a union. Validate the actual JSON DTO.
        const parsed = contract.safeParse(JSON.parse(JSON.stringify(value)));
        if (!parsed.success) {
          setInvalidFields(parsed.error.issues.slice(0, 5).map(issue => issue.path.length ? issue.path.map(part => typeof part === 'number' ? part + 1 : t(`ai.fields.${String(part)}`)).join(' / ') : t('ai.settings')));
          setInvalid(true); return;
        }
        setBusy(true);
        try { await onSave(parsed.data); if (mounted.current && clearDirtyOnSubmit) onDirty(false); }
        catch (failure) { setError(errorCode(failure)); }
        finally { setBusy(false); }
      }}>
      <div className="form-footer"><span className="help">{t(dirty ? 'state.dirty' : 'state.unchanged')}</span><button type="submit" className="primary" disabled={busy || requireDirty && !dirty}>{t(busy ? 'common:actions.saving' : submitKey)}</button></div>
    </Form>
  </div>;
}
