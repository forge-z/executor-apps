const dayFormat = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'});

export function dateBrt(now: Date): string {
  const parts = dayFormat.formatToParts(now);
  const part = (k: string) => parts.find(p => p.type === k)!.value;
  return [part('year'), part('month'), part('day')].join('-');
}

export function windowFor(now: Date) {
  const date_brt = dateBrt(now);
  const monday = new Date(date_brt + 'T00:00:00Z').getUTCDay() === 1;
  return {date_brt, start: new Date(now.getTime() - (monday ? 72 : 24) * 3600_000).toISOString(), end: now.toISOString()};
}
export type Window = ReturnType<typeof windowFor>;

export function exactUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1000 || !/^https?:\/\//i.test(value) || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    // Filter the raw query to avoid changing encoded values, order or repeated parameters.
    const query = url.search.slice(1).split('&').filter(pair => {
      try { return !/^(utm_(source|medium|campaign|term|content|id)|fbclid|gclid|msclkid)$/i.test(decodeURIComponent(pair.split('=', 1)[0]!)); }
      catch { return true; }
    });
    url.search = query.join('&');
    return url.href.length <= 1000 ? url.href : null;
  } catch { return null; }
}

export function publication(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const day = new Date(value.slice(0,10) + 'T00:00:00Z');
  const parsed = new Date(value);
  if (!Number.isFinite(+day) || !Number.isFinite(+parsed) || day.toISOString().slice(0,10) !== value.slice(0,10)) return null;
  return parsed.toISOString();
}

export const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const excerpt = (v: unknown, max: number): string => typeof v === 'string' ? v.replace(/\s+/g,' ').trim().slice(0,max) : '';
