// Posie link preview: turns a shared link (e.g. a Pinterest pin) into { image, title, url, site }.
// Deploy: Supabase dashboard → Edge Functions → Deploy a new function → Via editor → name "unfurl" → paste this.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

// refuse addresses inside private networks
const isPrivate = (host: string) =>
  /^(localhost|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i.test(host) ||
  host.endsWith('.local') || host.endsWith('.internal');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { url } = await req.json();
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol) || isPrivate(target.hostname)) return json({ error: 'unsupported link' }, 400);

    const res = await fetch(target, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PosieBot/1.0; link preview)',
        'Accept': 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5',
      },
    });
    const type = res.headers.get('content-type') || '';
    if (type.startsWith('image/')) return json({ url: res.url, image: res.url, title: '', site: new URL(res.url).hostname });

    const html = (await res.text()).slice(0, 800_000);
    const meta = (...names: string[]) => {
      for (const n of names) {
        const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*>`, 'i'))?.[0];
        const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
        if (content) return decode(content.trim());
      }
      return '';
    };
    let image = meta('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src');
    if (image) image = new URL(image, res.url).href;
    const title = meta('og:title', 'twitter:title') || decode(html.match(/<title[^>]*>([^<]*)/i)?.[1] || '').trim();
    const page = meta('og:url') || res.url;
    return json({ url: page, image, title, site: meta('og:site_name') || new URL(res.url).hostname.replace(/^www\./, '') });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
