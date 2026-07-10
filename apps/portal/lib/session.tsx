'use client';

// Portal session context: the signed-in contact + language. The language
// toggle persists to the contact record (MP: applied to all outbound comms).

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, isAuthed } from './api';
import { translate, type DictKey, type Lang } from './i18n';

export interface Me {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  preferred_contact_method: string | null;
  language: Lang;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  estimate_reminders_enabled: boolean;
}

export interface NextEstimate {
  quarter: string;
  date: string;
}

interface SessionCtx {
  me: Me | null;
  nextEstimate: NextEstimate | null;
  ready: boolean;
  lang: Lang;
  t: (key: DictKey) => string;
  setLang: (lang: Lang) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionCtx>({
  me: null,
  nextEstimate: null,
  ready: false,
  lang: 'en',
  t: (k) => translate('en', k),
  setLang: () => {},
  refresh: async () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [nextEstimate, setNextEstimate] = useState<NextEstimate | null>(null);
  const [ready, setReady] = useState(false);
  const [lang, setLangState] = useState<Lang>('en');

  const refresh = useCallback(async () => {
    if (!isAuthed()) {
      setReady(true);
      return;
    }
    try {
      const res = await api<{ contact: Me; nextEstimate: NextEstimate | null }>('/portal/me');
      setMe(res.contact);
      setNextEstimate(res.nextEstimate);
      setLangState(res.contact.language);
    } catch {
      /* 401 handled by api() */
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    if (isAuthed()) {
      void api('/portal/me', { method: 'PATCH', body: { language: next } });
    }
  }, []);

  const t = useCallback((key: DictKey) => translate(lang, key), [lang]);

  return <Ctx.Provider value={{ me, nextEstimate, ready, lang, t, setLang, refresh }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  return useContext(Ctx);
}
