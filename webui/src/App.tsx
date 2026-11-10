import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from '../../shared/schemas';
import { errorCodeSchema, supportedLocales } from '../../shared/schemas';
import { ApiError, clearSession, errorCode, establishSession, exchangeMiniApp, request } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { GroupsPage, ModulesPage, PreferencesPage, SettingsPage, StatusPage } from './pages';
import { telegram, useTheme, type Theme } from './platform';
import i18n from './i18n';

type Page = 'status' | 'groups' | 'settings' | 'modules' | 'preferences';
type Auth = { state: 'checking' } | { state: 'signedOut'; reason?: string } | { state: 'authenticated'; me: Me };
const pages: Page[] = ['status', 'groups', 'settings', 'modules', 'preferences'];

// One credential exchange per document. A failed/expired Mini App must be reopened, not replayed.
let bootstrap: Promise<Me> | undefined;
let miniAppAttempted = false;
function authenticate() {
  bootstrap ??= (async () => {
    telegram?.ready(); telegram?.expand();
    if (telegram) {
      if (miniAppAttempted) throw new ApiError('AUTH_EXPIRED');
      miniAppAttempted = true;
      await exchangeMiniApp(telegram.initData);
    }
    const me = await request<Me>('/api/me');
    establishSession(me);
    return me;
  })().finally(() => { bootstrap = undefined; });
  return bootstrap;
}

export function App() {
  const { t } = useTranslation();
  const [auth, setAuth] = useState<Auth>({ state: 'checking' });
  const [page, setPage] = useState<Page>('status');
  const [moduleId, setModuleId] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [destination, setDestination] = useState<Page>();
  const [logout, setLogout] = useState(false);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    const authError = errorCodeSchema.safeParse(new URL(window.location.href).searchParams.get('auth_error'));
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    void authenticate().then((me) => { setAuth({ state: 'authenticated', me }); void i18n.changeLanguage(me.resolvedLanguage); })
      .catch((error: unknown) => { clearSession(); setAuth({ state: 'signedOut', reason: authError.success ? authError.data : errorCode(error) === 'UNAUTHORIZED' ? undefined : errorCode(error) }); });
    function expire() {
      clearSession(); setAuth((current) => current.state === 'authenticated' ? { state: 'signedOut', reason: 'expired' } : current);
      setDirty(false); setLogout(false); setDestination(undefined); setModuleId(undefined); setPage('status');
    }
    window.addEventListener('misaka:expired', expire);
    return () => window.removeEventListener('misaka:expired', expire);
  }, [i18n]);

  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? 'zh-CN';
    document.title = `${t('common:appName')} / ${t(auth.state === 'authenticated' ? `nav.${page}` : 'auth.login')}`;
  }, [i18n.resolvedLanguage, t, auth.state, page]);

  useEffect(() => {
    if (auth.state !== 'authenticated') return;
    const timeout = window.setTimeout(() => { clearSession(); window.dispatchEvent(new Event('misaka:expired')); }, Math.max(0, new Date(auth.me.expiresAt).getTime() - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [auth]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  function navigate(next: Page) {
    if (next === page && !moduleId) return;
    if (dirty) { setDestination(next); return; }
    setPage(next); setModuleId(undefined);
  }
  useEffect(() => {
    if (!telegram) return;
    const back = () => {
      if (dirty) setDestination(moduleId ? 'modules' : 'status');
      else { setPage(moduleId ? 'modules' : 'status'); setModuleId(undefined); }
    };
    if (auth.state === 'authenticated' && (page !== 'status' || moduleId)) telegram.BackButton.show();
    else telegram.BackButton.hide();
    telegram.BackButton.onClick(back);
    return () => telegram?.BackButton.offClick(back);
  }, [auth.state, page, moduleId, dirty]);

  const themeControl = <label className="theme-control"><span>{t('theme.label')}</span><select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>{(['auto', 'light', 'dark'] as const).map((value) => <option key={value} value={value}>{t(`theme.${value}`)}</option>)}</select></label>;
  if (auth.state !== 'authenticated') return <div className="login-layout"><header className="login-header"><span className="brand">{t('common:appName')}<span className="brand-dot" /></span>{themeControl}</header>
    <main className="login-main"><p className="eyebrow">{t(telegram ? 'auth.miniapp' : 'auth.browser')}</p><h1>{t('auth.title')}</h1><p className="login-description">{t('auth.description')}</p>
      {auth.state === 'checking' ? <p role="status">{t('auth.checking')}</p> : <>
        {auth.reason && <p className="notice" role="alert">{t(['expired', 'loggedOut', 'logoutFailed'].includes(auth.reason) ? `auth.${auth.reason}` : `common:errors.${auth.reason}`)}</p>}
        {telegram ? <p>{t('auth.reopen')}</p> : <a className="button primary" href="/auth/login">{t('auth.login')}<span aria-hidden="true">&#8599;</span></a>}
      </>}
      <div className="login-language"><label htmlFor="login-language">{t('preferences.language')}</label><select id="login-language" value={i18n.resolvedLanguage} onChange={(event) => { void i18n.changeLanguage(event.target.value); }}>{supportedLocales.map(locale => <option key={locale} value={locale}>{t(`common:languages.${locale}`)}</option>)}</select></div>
    </main><footer className="login-footer">{t('tagline')}</footer></div>;

  return <div className="app-shell">
    <a className="skip-link" href="#main">{t('nav.skip')}</a>
    <aside className="sidebar"><div className="brand">{t('common:appName')}<span className="brand-dot" /></div><p className="sidebar-caption">{t('tagline')}</p>
      <nav aria-label={t('nav.label')}>{pages.map((item, index) => <button key={item} aria-current={page === item ? 'page' : undefined} onClick={() => navigate(item)}><span className="nav-index" aria-hidden="true">0{index + 1}</span><span>{t(`nav.${item}`)}</span></button>)}</nav>
      <div className="sidebar-bottom"><span className="help">{t(telegram ? 'auth.miniapp' : 'auth.browser')}</span><span className="mono">{auth.me.user.id}</span></div>
    </aside>
    <div className="workspace"><header className="topbar"><span className="user-name">{auth.me.user.name}</span><div className="topbar-actions">{themeControl}<button onClick={() => setLogout(true)}>{t('common:actions.logout')}</button></div></header>
      <main id="main" className="main-content" tabIndex={-1}><div className="page-heading"><p className="eyebrow">{t('tagline')}</p><h1>{t(`${page}.title`)}</h1><p>{t(`${page}.description`)}</p></div>
        {page === 'status' && <StatusPage />}
        {page === 'groups' && <GroupsPage onDirty={setDirty} />}
        {page === 'settings' && <SettingsPage onDirty={setDirty} />}
        {page === 'modules' && (moduleId ? <><button className="text-button" onClick={() => navigate('modules')}>{t('modules.back')}</button><SettingsPage moduleId={moduleId} onDirty={setDirty} /></> : <ModulesPage configure={setModuleId} />)}
        {page === 'preferences' && <PreferencesPage onDirty={setDirty} onSaved={(preference) => { setAuth({ state: 'authenticated', me: { ...auth.me, ...preference } }); void i18n.changeLanguage(preference.resolvedLanguage); }} />}
      </main>
    </div>
    {destination && <ConfirmDialog title={t('state.leaveTitle')} confirm={t('state.discard')} onCancel={() => setDestination(undefined)} onConfirm={() => { setDirty(false); setPage(destination); setModuleId(undefined); setDestination(undefined); }}><p>{t('state.leaveHelp')}</p></ConfirmDialog>}
    {logout && <ConfirmDialog title={t('auth.logoutTitle')} confirm={t('common:actions.logout')} busy={busy} onCancel={() => setLogout(false)} onConfirm={() => {
      if (busy) return; setBusy(true);
      void request('/auth/logout', 'POST', {}).then(() => 'loggedOut', () => 'logoutFailed').then((reason) => {
        clearSession(); setDirty(false); setLogout(false); setBusy(false); setModuleId(undefined); setPage('status'); setAuth({ state: 'signedOut', reason });
      });
    }}><p>{t('auth.logoutHelp')}</p>{dirty && <p className="error-text">{t('state.leaveHelp')}</p>}</ConfirmDialog>}
  </div>;
}
