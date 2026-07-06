'use client';

// Portal session context: the signed-in contact + language. The language
// toggle persists to the contact record (MP: applied to all outbound comms).

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken } from './api';
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
}

interface SessionCtx {
  me: Me | null;
  ready: boolean;
  lang: Lang;
  t: (key: DictKey) => string;
  setLang: (lang: Lang) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionCtx>({
  me: null,
  ready: false,
  lang: 'en',
  t: (k) => translate('en', k),
  setLang: () => {},
  refresh: async () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [lang, setLangState] = useState<Lang>('en');

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    try {
      const res = await api<{ contact: Me }>('/portal/me');
      setMe(res.contact);
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
    if (getToken()) {
      void api('/portal/me', { method: 'PATCH', body: { language: next } });
    }
  }, []);

  const t = useCallback((key: DictKey) => translate(lang, key), [lang]);

  return <Ctx.Provider value={{ me, ready, lang, t, setLang, refresh }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  return useContext(Ctx);
}
