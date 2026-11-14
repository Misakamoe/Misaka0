import { useState } from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { useTranslation } from 'react-i18next';
import type { ErrorCode } from '../../shared/schemas';
import type { AiToolCatalog } from '../../shared/schemas/ai-admin';

export interface AiToolPickerState {
  catalog?: AiToolCatalog;
  loading: boolean;
  error?: ErrorCode;
  searchConfigured: boolean;
  localQualified: boolean;
  reload(): void;
}

const groupOrder = ['search', 'rate', 'weather', 'rss', 'sticker', 'subconv', 'memory', 'skills', 'mcp', 'sandbox', 'local', 'automation', 'alias', 'core', 'ai', 'other'];

export function AiToolPicker({ id, value, onChange, disabled, readonly, schema, label, registry, rawErrors }: WidgetProps) {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const state = (registry.formContext as { aiTools?: AiToolPickerState }).aiTools;
  const selected: string[] = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const items = state?.catalog?.items ?? [];
  const limit = typeof schema.maxItems === 'number' ? schema.maxItems : 64;
  const locked = Boolean(disabled || readonly);
  const name = (tool: string) => t(`ai.toolPicker.names.${tool.replaceAll('.', '_')}`, { defaultValue: tool });
  const groupName = (group: string) => t(`ai.toolPicker.groups.${group}`, { defaultValue: t('ai.toolPicker.groups.other') });
  const needle = search.trim().toLocaleLowerCase(i18n.resolvedLanguage);
  const matches = (tool: string, group = '') => `${name(tool)} ${tool} ${groupName(group)}`.toLocaleLowerCase(i18n.resolvedLanguage).includes(needle);
  const filtered = items.filter(item => (!selectedOnly || selected.includes(item.id)) && matches(item.id, item.group));
  const groups = [...new Set(filtered.map(item => item.group))].sort((left, right) => {
    const rank = (group: string) => groupOrder.includes(group) ? groupOrder.indexOf(group) : groupOrder.length;
    return rank(left) - rank(right) || left.localeCompare(right);
  });
  const known = new Set(items.map(item => item.id));
  const unknown = selected.filter(item => !known.has(item) && matches(item));
  function toggle(tool: string, checked: boolean) {
    if (locked) return;
    if (!checked) onChange(selected.filter(item => item !== tool));
    else if (!state?.loading && !state?.error && known.has(tool) && !selected.includes(tool) && selected.length < limit) onChange([...selected, tool]);
  }
  return <fieldset id={id} className="ai-tool-picker" disabled={locked} aria-describedby={`${id}-help ${id}-count`} aria-invalid={Boolean(rawErrors?.length)}>
    <legend>{label || t('ai.toolPicker.title')}</legend>
    <p id={`${id}-help`} className="help">{t('ai.toolPicker.help')}</p>
    <div className="ai-tool-search">
      <div><label htmlFor={`${id}-search`}>{t('ai.toolPicker.search')}</label>
        <input id={`${id}-search`} type="search" value={search} onChange={event => setSearch(event.target.value)} autoComplete="off" /></div>
      <button type="button" disabled={locked || state?.loading || !state} onClick={() => state?.reload()}>{t('ai.toolPicker.reload')}</button>
    </div>
    <div className="ai-tool-selection">
      <label><input type="checkbox" checked={selectedOnly} onChange={event => setSelectedOnly(event.target.checked)} />{t('ai.toolPicker.selectedOnly')}</label>
      <span id={`${id}-count`} className="help" aria-live="polite">{t('ai.toolPicker.selected', { selected: selected.length, limit })}</span>
      <button type="button" disabled={locked || !selected.length} onClick={() => onChange([])}>{t('ai.toolPicker.clear')}</button>
    </div>
    {selected.length >= limit && <p className="help">{t('ai.toolPicker.atLimit', { limit })}</p>}
    {state?.loading && <p role="status" className="help">{t('ai.toolPicker.loading')}</p>}
    {state?.error && <p role="alert" className="notice error">{t('ai.toolPicker.loadFailed')} {t(`common:errors.${state.error}`)}</p>}
    <div className="ai-tool-groups">
      {unknown.length > 0 && <section aria-labelledby={`${id}-unknown`}>
        <h3 id={`${id}-unknown`}>{t(state?.catalog ? 'ai.toolPicker.unknown' : 'ai.toolPicker.saved')}</h3>
        <p className="help">{t(state?.catalog ? 'ai.toolPicker.unknownHelp' : 'ai.toolPicker.savedHelp')}</p>
        {unknown.map(tool => <label key={tool} className="ai-tool-option">
          <input type="checkbox" aria-label={name(tool)} checked onChange={event => toggle(tool, event.target.checked)} />
          <span><span className="ai-tool-name">{name(tool)}</span><code>{tool}</code></span>
        </label>)}
      </section>}
      {groups.map(group => <section key={group} aria-labelledby={`${id}-group-${group}`}>
        <h3 id={`${id}-group-${group}`}>{groupName(group)}</h3>
        {group === 'search' && !state?.searchConfigured && <p className="help">{t('ai.toolPicker.searchSetup')}</p>}
        {group === 'local' && !state?.localQualified && <p className="help">{t('ai.toolPicker.localSetup')}</p>}
        {['skills', 'mcp', 'sandbox', 'local'].includes(group) && <p className="help">{t('ai.toolPicker.extensionSetup')}</p>}
        {filtered.filter(item => item.group === group).map(item => {
          const checked = selected.includes(item.id);
          return <label key={item.id} className="ai-tool-option" data-effect={item.effect}>
            <input type="checkbox" aria-label={name(item.id)} aria-describedby={`${id}-${item.id}-details`} checked={checked}
              disabled={locked || !checked && (state?.loading || Boolean(state?.error) || selected.length >= limit)} onChange={event => toggle(item.id, event.target.checked)} />
            <span><span className="ai-tool-name">{name(item.id)}</span><span id={`${id}-${item.id}-details`} className="ai-tool-details">
              <code>{item.id}</code><span className="ai-tool-badges"><span>{t(`ai.toolPicker.effects.${item.effect}`)}</span>
                <span>{t(item.scopes.length > 1 ? 'ai.toolPicker.scopes.both' : `ai.toolPicker.scopes.${item.scopes[0]}`)}</span>
                {item.permission !== 'any' && <span>{t(`ai.toolPicker.permissions.${item.permission}`)}</span>}
                {item.approval !== 'none' && <span>{t(`ai.toolPicker.approvals.${item.approval}`)}</span>}
              </span></span></span>
          </label>;
        })}
      </section>)}
      {!state?.loading && !state?.error && !filtered.length && !unknown.length && <p className="help">{t(needle || selectedOnly ? 'ai.toolPicker.noMatches' : 'ai.toolPicker.empty')}</p>}
    </div>
  </fieldset>;
}
