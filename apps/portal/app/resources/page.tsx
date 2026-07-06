'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';

interface Resource {
  id: string; title_en: string; title_es: string | null;
  description_en: string | null; description_es: string | null;
  resource_type: string; url: string | null;
}

export default function ResourcesPage() {
  const { t, lang } = useSession();
  const [resources, setResources] = useState<Resource[]>([]);

  useEffect(() => {
    void api<{ resources: Resource[] }>('/portal/resources').then((r) => setResources(r.resources));
  }, []);

  return (
    <>
      <h1>{t('res_title')}</h1>
      {resources.map((r) => (
        <section className="card" key={r.id}>
          <h2>{lang === 'es' ? (r.title_es ?? r.title_en) : r.title_en}</h2>
          <p className="muted">{lang === 'es' ? (r.description_es ?? r.description_en) : r.description_en}</p>
          {r.url ? (
            <a className="btn ghost" href={r.url} target="_blank" rel="noreferrer">
              →
            </a>
          ) : null}
        </section>
      ))}
    </>
  );
}
