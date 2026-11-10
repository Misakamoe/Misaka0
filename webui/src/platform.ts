import { useEffect, useState } from 'react';

interface Insets { top: number; bottom: number; left: number; right: number }
export interface TelegramApp {
  initData: string;
  colorScheme: 'light' | 'dark';
  themeParams?: { bg_color?: string; secondary_bg_color?: string; text_color?: string; hint_color?: string; link_color?: string };
  safeAreaInset?: Insets;
  contentSafeAreaInset?: Insets;
  ready(): void;
  expand(): void;
  onEvent(name: string, handler: () => void): void;
  offEvent(name: string, handler: () => void): void;
  BackButton: { show(): void; hide(): void; onClick(handler: () => void): void; offClick(handler: () => void): void };
}
declare global { interface Window { Telegram?: { WebApp?: TelegramApp } } }

export const telegram = window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : undefined;
export type Theme = 'auto' | 'light' | 'dark';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>('auto');
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    function sync() {
      const scheme = theme === 'auto' ? telegram?.colorScheme ?? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = scheme;
      // Follow the host's light/dark mode, while keeping one coherent, readable application palette.
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const inset = (telegram?.safeAreaInset?.[side] ?? 0) + (telegram?.contentSafeAreaInset?.[side] ?? 0);
        document.documentElement.style.setProperty(`--tg-inset-${side}`, `${Math.max(0, inset)}px`);
      }
    }
    sync();
    media.addEventListener('change', sync);
    for (const event of ['themeChanged', 'safeAreaChanged', 'contentSafeAreaChanged']) telegram?.onEvent(event, sync);
    return () => {
      media.removeEventListener('change', sync);
      for (const event of ['themeChanged', 'safeAreaChanged', 'contentSafeAreaChanged']) telegram?.offEvent(event, sync);
    };
  }, [theme]);
  return [theme, setTheme] as const;
}
