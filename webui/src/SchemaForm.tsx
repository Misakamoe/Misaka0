import { useState } from 'react';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { ErrorSchemaBuilder, TranslatableString, type ArrayFieldItemTemplateProps, type FieldTemplateProps, type IconButtonProps, type RJSFSchema, type UiSchema, type WidgetProps } from '@rjsf/utils';
import { useTranslation } from 'react-i18next';
import type { SettingsDescriptor, SettingFieldMetadata } from '../../shared/schemas';
import { secretChangeSchema } from '../../shared/schemas';
import { ApiError, errorCode } from './api';
import { ConfirmDialog } from './ConfirmDialog';

type Values = Record<string, unknown>;
export interface FormSnapshot { revision: number; saved: Values; effective: Values; requiresRestart: boolean }

function FieldTemplate({ id, label, displayLabel, required, children, description, errors, help, rawErrors }: FieldTemplateProps) {
  const { t } = useTranslation();
  return <div className={`schema-field${rawErrors?.length ? ' has-error' : ''}`}>
    {displayLabel && <div className="field-label"><label htmlFor={id}>{label}</label>{required && <span className="help">{t('state.required')}</span>}</div>}
    {description}{children}{errors}{help}
  </div>;
}

function FormButton({ actionKey, id, onClick, disabled }: IconButtonProps & { actionKey: string }) {
  const { t } = useTranslation();
  return <button type="button" id={id} onClick={onClick} disabled={disabled} aria-label={t(actionKey)}>{t(actionKey)}</button>;
}
const buttonTemplates = {
  AddButton: (props: IconButtonProps) => <FormButton {...props} actionKey="common:actions.add" />,
  RemoveButton: (props: IconButtonProps) => <FormButton {...props} actionKey="common:actions.remove" />,
  MoveUpButton: (props: IconButtonProps) => <FormButton {...props} actionKey="common:actions.moveUp" />,
  MoveDownButton: (props: IconButtonProps) => <FormButton {...props} actionKey="common:actions.moveDown" />,
  CopyButton: (props: IconButtonProps) => <FormButton {...props} actionKey="form.copy" />,
  ClearButton: (props: IconButtonProps) => <FormButton {...props} actionKey="form.clear" />,
};

function ArrayItemTemplate({ children, buttonsProps, hasToolbar, registry }: ArrayFieldItemTemplateProps) {
  const Buttons = registry.templates.ArrayFieldItemButtonsTemplate;
  return <div className="array-row"><div className="array-row-fields">{children}</div>{hasToolbar && <div className="array-row-tools"><Buttons {...buttonsProps} /></div>}</div>;
}

function metadata(descriptor: SettingsDescriptor, path: string): SettingFieldMetadata | undefined {
  return descriptor.fields[path] ?? descriptor.fields[path.replace(/\.\d+(?=\.|$)/g, '.*')];
}

// The response contains presence markers, never secret values. Strip them before RJSF sees form data.
function editable(value: unknown, descriptor: SettingsDescriptor, path = ''): unknown {
  if (metadata(descriptor, path)?.secret) return undefined;
  if (Array.isArray(value)) return value.map((item, index) => editable(item, descriptor, `${path}.${index}`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const next = editable(item, descriptor, path ? `${path}.${key}` : key);
    return next === undefined ? [] : [[key, next]];
  }));
  return value;
}

function submission(value: unknown, descriptor: SettingsDescriptor, path = ''): unknown {
  const field = metadata(descriptor, path);
  if (field?.readOnly) return undefined;
  if (field?.secret) {
    if (value === '' || value === undefined) return undefined;
    const change = secretChangeSchema.safeParse(value === null ? { operation: 'clear' } : { operation: 'replace', value });
    if (!change.success) throw new ApiError('INVALID_INPUT', [path]);
    return change.data;
  }
  if (Array.isArray(value)) return value.map((item, index) => submission(item, descriptor, `${path}.${index}`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const next = submission(item, descriptor, path ? `${path}.${key}` : key);
    return next === undefined ? [] : [[key, next]];
  }));
  return value;
}

function SecretWidget({ id, value, disabled, readonly, onChange, options, rawErrors }: WidgetProps) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const hasValue = Boolean(options.hasValue);
  return <div className="secret-control">
    <input id={id} type="password" autoComplete="new-password" value={typeof value === 'string' ? value : ''}
      disabled={disabled || readonly} aria-invalid={Boolean(rawErrors?.length)} aria-describedby={`${id}-presence`}
      placeholder={t('settings.secretReplacement')} onChange={(event) => onChange(event.target.value || undefined)} />
    <p className="help" id={`${id}-presence`}>{t(value === null ? 'settings.secretCleared' : hasValue ? 'settings.secretSet' : 'settings.secretEmpty')}</p>
    {!readonly && hasValue && <button type="button" className="text-button" disabled={disabled}
      onClick={() => value === null ? onChange(undefined) : setConfirm(true)}>
      {t(value === null ? 'settings.secretUndo' : 'settings.secretClear')}
    </button>}
    {confirm && <ConfirmDialog title={t('settings.secretTitle')} danger onCancel={() => setConfirm(false)}
      onConfirm={() => { onChange(null); setConfirm(false); }}><p>{t('settings.secretHelp')}</p></ConfirmDialog>}
  </div>;
}

export function SchemaForm({ descriptor, snapshot, onSave, onDirty, onReload }: {
  descriptor: SettingsDescriptor; snapshot: FormSnapshot; onSave(settings: Values): Promise<void>;
  onDirty(dirty: boolean): void; onReload(): void;
}) {
  const { t } = useTranslation();
  const baseline = editable(snapshot.saved, descriptor) as Values;
  const [data, setData] = useState(baseline);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [invalid, setInvalid] = useState(false);
  const dirty = JSON.stringify(data) !== JSON.stringify(baseline);
  const fieldErrors = new ErrorSchemaBuilder();
  for (const field of error?.fields ?? []) {
    const path = field.replace(/^settings\./, '');
    if (metadata(descriptor, path)) fieldErrors.addErrors(t('state.fieldError'), path);
  }

  function localize(source: RJSFSchema, path = '', saved: unknown = snapshot.saved): [RJSFSchema, UiSchema] {
    const schema = structuredClone(source);
    const field = metadata(descriptor, path);
    const ui: UiSchema = {};
    delete schema.description;
    if (field) {
      schema.title = t(field.labelKey);
      const help = [field.descriptionKey && t(field.descriptionKey), t(field.readOnly ? 'settings.readOnly' : field.effect === 'restart_required' ? 'settings.restart' : 'settings.immediate')].filter(Boolean).join(' / ');
      ui['ui:description'] = help;
      ui['ui:readonly'] = field.readOnly;
      if (field.secret) {
        delete schema.default;
        // A clear is an explicit null; an omitted field preserves the server-held value.
        schema.type = ['string', 'null'];
        schema.minLength = 1;
        schema.maxLength = 16_384;
        ui['ui:widget'] = 'Secret';
        ui['ui:options'] = { hasValue: Boolean(saved && typeof saved === 'object' && 'has_value' in saved && saved.has_value) };
      } else if (field.control) ui['ui:widget'] = field.control;
      if (field.enumKeys && schema.enum) {
        schema.oneOf = schema.enum.map((value) => ({ const: value, title: t(field.enumKeys![String(value)] ?? 'form.invalid') }));
        delete schema.enum;
      }
    } else if (path) schema.title = t('form.item');
    else delete schema.title;
    if (schema.properties) {
      schema.required = schema.required?.filter((key) => !metadata(descriptor, path ? `${path}.${key}` : key)?.secret);
      for (const [key, child] of Object.entries(schema.properties)) {
        if (typeof child !== 'object') continue;
        const childSaved = saved && typeof saved === 'object' ? (saved as Values)[key] : undefined;
        const [next, nextUi] = localize(child, path ? `${path}.${key}` : key, childSaved);
        schema.properties[key] = next;
        ui[key] = nextUi;
      }
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      const [next, nextUi] = localize(schema.items, `${path}.*`, undefined);
      schema.items = next;
      ui.items = Array.isArray(saved) ? (_item: unknown, index: number) => localize(source.items as RJSFSchema, `${path}.${index}`, saved[index])[1] : nextUi;
    }
    return [schema, ui];
  }
  const [schema, uiSchema] = localize(descriptor.schema as RJSFSchema);
  uiSchema['ui:order'] = [...descriptor.order, '*'];
  const stringKeys: Partial<Record<TranslatableString, string>> = {
    [TranslatableString.ArrayItemTitle]: 'form.item', [TranslatableString.EmptyArray]: 'form.emptyArray',
    [TranslatableString.YesLabel]: 'common:yes', [TranslatableString.NoLabel]: 'common:no',
    [TranslatableString.CloseLabel]: 'common:actions.close', [TranslatableString.ErrorsLabel]: 'form.errors',
    [TranslatableString.AddButton]: 'common:actions.add', [TranslatableString.AddItemButton]: 'common:actions.add',
    [TranslatableString.CopyButton]: 'form.copy', [TranslatableString.ExpandButton]: 'form.expand',
    [TranslatableString.MoveDownButton]: 'common:actions.moveDown', [TranslatableString.MoveUpButton]: 'common:actions.moveUp',
    [TranslatableString.RemoveButton]: 'common:actions.remove', [TranslatableString.NowLabel]: 'form.now',
    [TranslatableString.ClearLabel]: 'form.clear', [TranslatableString.ClearButton]: 'form.clear',
    [TranslatableString.AriaDateLabel]: 'form.date', [TranslatableString.PreviewLabel]: 'form.preview',
    [TranslatableString.DecrementAriaLabel]: 'form.decrease', [TranslatableString.IncrementAriaLabel]: 'form.increase',
    [TranslatableString.OptionalObjectAdd]: 'form.optionalAdd', [TranslatableString.OptionalObjectRemove]: 'form.optionalRemove',
    [TranslatableString.OptionalObjectEmptyMsg]: 'form.optionalEmpty', [TranslatableString.Type]: 'form.type',
    [TranslatableString.Value]: 'form.value', [TranslatableString.NewStringDefault]: 'form.value',
  };

  return <div className="schema-editor">
    {snapshot.requiresRestart && <div className="notice" role="status"><p>{t('settings.restartPending')}</p>
      <details><summary>{t('settings.effective')}</summary><dl className="effective-values">
        {Object.entries(descriptor.fields).filter(([, field]) => field.effect === 'restart_required').map(([path, field]) => {
          const value = path.split('.').reduce<unknown>((entry, key) => entry && typeof entry === 'object' ? (entry as Values)[key] : undefined, snapshot.effective);
          return <div key={path}><dt>{t(field.labelKey)}</dt><dd>{field.secret ? t(value && typeof value === 'object' && 'has_value' in value && value.has_value ? 'settings.secretSet' : 'settings.secretEmpty') : field.enumKeys ? t(field.enumKeys[String(value)] ?? 'state.noValue') : typeof value === 'boolean' ? t(value ? 'common:yes' : 'common:no') : typeof value === 'string' || typeof value === 'number' ? String(value) : t('state.noValue')}</dd></div>;
        })}
      </dl></details></div>}
    {error && <div role="alert" className="notice error"><p>{t(`common:errors.${error.code}`)}</p>
      {error.fields.map((path) => <p key={path}>{t(metadata(descriptor, path)?.labelKey ?? 'form.value')}: {t(metadata(descriptor, path)?.secret ? 'settings.secretMasked' : 'state.fieldError')}</p>)}
      {error.code === 'CONFLICT' && <><p>{t('state.reloadHelp')}</p><button type="button" onClick={onReload}>{t('state.reload')}</button></>}
    </div>}
    {invalid && <p role="alert" className="error-text">{t('state.validation')}</p>}
    <Form schema={schema} uiSchema={uiSchema} validator={validator} formData={data} disabled={busy}
      extraErrors={fieldErrors.ErrorSchema}
      widgets={{ Secret: SecretWidget }} noHtml5Validate showErrorList={false}
      templates={{ FieldTemplate, ArrayFieldItemTemplate: ArrayItemTemplate, ButtonTemplates: buttonTemplates, DescriptionFieldTemplate: ({ id, description }) => description ? <p id={id} className="help">{description}</p> : null }}
      translateString={(key, params) => {
        if (key === TranslatableString.OptionPrefix || key === TranslatableString.TitleOptionPrefix) return t('form.option', { index: params?.at(-1) });
        if (key === TranslatableString.KeyLabel) return t('form.key', { label: params?.[0] });
        return t(stringKeys[key] ?? 'form.unsupported');
      }}
      transformErrors={(errors) => errors.map((item) => ({ ...item, message: t(`form.${['required', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern', 'uniqueItems'].includes(item.name ?? '') ? item.name : 'invalid'}`, { limit: item.params?.limit }) }))}
      onError={() => setInvalid(true)} onChange={(event) => {
        const next = event.formData ?? {};
        setData(next); setError(undefined); setInvalid(false);
        onDirty(JSON.stringify(next) !== JSON.stringify(baseline));
      }} onSubmit={async () => {
        if (busy) return;
        setBusy(true); setError(undefined); setInvalid(false);
        try { await onSave(submission(data, descriptor) as Values); onDirty(false); }
        catch (failure) { setError(failure instanceof ApiError ? failure : new ApiError(errorCode(failure))); }
        finally { setBusy(false); }
      }}>
      <div className="form-footer"><span className="help" aria-live="polite">{t(dirty ? 'state.dirty' : 'state.unchanged')}</span>
        <button type="submit" className="primary" disabled={busy || !dirty || error?.code === 'CONFLICT'}>{t(busy ? 'common:actions.saving' : 'common:actions.save')}</button>
      </div>
    </Form>
  </div>;
}
