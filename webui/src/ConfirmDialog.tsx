import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function ConfirmDialog({ title, children, confirm, onConfirm, onCancel, busy = false, danger = false }: {
  title: string; children: ReactNode; confirm?: string; onConfirm(): void; onCancel(): void; busy?: boolean; danger?: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => { previous?.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby="confirmation-title" onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="confirmation-title">{title}</h2>
    <div className="dialog-body">{children}</div>
    <div className="button-row">
      <button type="button" autoFocus disabled={busy} onClick={onCancel}>{t('common:actions.cancel')}</button>
      <button type="button" className={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
        {busy ? t('common:actions.saving') : confirm ?? t('common:actions.confirm')}
      </button>
    </div>
  </dialog>;
}
