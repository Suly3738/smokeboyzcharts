// PixaCharts – cotygodniowe notowanie utworów z kanału YouTube.
// Uruchom: node update.mjs   (lub update.cmd)
// Wynik: data.json, history.json, index.html

import { Innertube, Log } from 'youtubei.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const p = (f) => path.join(ROOT, f);
const cfg = JSON.parse(fs.readFileSync(p('config.json'), 'utf8'));

const log = (...a) => console.log(new Date().toLocaleTimeString('pl-PL'), ...a);
Log.setLevel(Log.Level.NONE); // wycisza ostrzeżenia parsera youtubei.js o nowych, nieznanych elementach strony

// ---------- pomocnicze ----------

function parseViewsText(txt = '') {
  // "1,9 tys. wyświetleń" -> 1900, "1 mln" -> 1000000, "201 wyświetleń" -> 201
  const m = txt.replace(/\s/g, ' ').match(/([\d\s.,]+)\s*(tys|mln|mld)?/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
  if (Number.isNaN(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'tys') n *= 1e3;
  else if (unit === 'mln') n *= 1e6;
  else if (unit === 'mld') n *= 1e9;
  return Math.round(n);
}

function parseTitle(title) {
  const m = title.match(/^(.*?)\s+[-–—]\s+(.*)$/);
  if (!m) return { artist: '', song: title.trim() };
  const artist = m[1].trim();
  // usuń dopiski typu (Official Music Video), [Oficial Music Video], (Official Audio)
  const song = m[2].replace(/\s*[(\[](?:official|oficial)[^)\]]*[)\]]/gi, '').trim() || m[2].trim();
  return { artist, song };
}

function isExcluded(title) {
  const norm = title.normalize('NFKC');
  const kw = cfg.excludeKeyword || '';
  if (!kw) return false;
  return cfg.excludeCaseSensitive
    ? norm.includes(kw)
    : norm.toLowerCase().includes(kw.toLowerCase());
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

async function withRetry(fn, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
  throw err;
}

// ---------- 1. pobranie filmów z kanału ----------
// Dwa tryby:
//  a) YT_API_KEY ustawiony  -> oficjalne YouTube Data API v3 (dokładne liczby, działa z serwerów, np. GitHub Actions)
//  b) brak klucza           -> youtubei.js (bez klucza; z serwerów YouTube często blokuje szczegóły filmów
//                              i wtedy zostają zaokrąglone liczby z listy kanału)
// Oba tryby zwracają { channelTitle, raw: [{ id, title, views, order (0 = najnowszy), publishedText, exact }] }

async function fetchViaApi(apiKey) {
  const API = 'https://www.googleapis.com/youtube/v3/';
  const get = async (endpoint, params) => {
    const url = API + endpoint + '?' + new URLSearchParams({ ...params, key: apiKey });
    const res = await withRetry(async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${endpoint}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
      return r.json();
    });
    return res;
  };

  const handle = cfg.channelUrl.match(/@([^/?#]+)/)?.[1];
  const chRes = await get('channels', handle
    ? { part: 'snippet,contentDetails', forHandle: handle }
    : { part: 'snippet,contentDetails', id: cfg.channelId });
  const ch = chRes.items?.[0];
  if (!ch) throw new Error('Data API: nie znaleziono kanału ' + cfg.channelUrl);
  const uploads = ch.contentDetails.relatedPlaylists.uploads;

  const items = [];
  let pageToken;
  do {
    const r = await get('playlistItems', { part: 'snippet,contentDetails', playlistId: uploads, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
    for (const it of r.items ?? []) {
      if (it.snippet?.title === 'Private video' || it.snippet?.title === 'Deleted video') continue;
      items.push({ id: it.contentDetails.videoId, title: it.snippet.title, publishedAt: it.contentDetails.videoPublishedAt ?? it.snippet.publishedAt });
    }
    pageToken = r.nextPageToken;
  } while (pageToken);

  // playlista „uploads” jest od najnowszego; dla pewności sortujemy po dacie publikacji
  items.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));

  const stats = {};
  for (let i = 0; i < items.length; i += 50) {
    const r = await get('videos', { part: 'statistics,snippet', id: items.slice(i, i + 50).map(v => v.id).join(',') });
    for (const v of r.items ?? []) stats[v.id] = { views: Number(v.statistics?.viewCount ?? 0), title: v.snippet?.title };
  }

  const raw = items
    .filter(v => stats[v.id]) // pomija filmy niedostępne publicznie
    .map((v, order) => ({
      id: v.id,
      title: stats[v.id].title ?? v.title,
      views: stats[v.id].views,
      order,
      publishedText: v.publishedAt ? new Date(v.publishedAt).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' }) : '',
      exact: true,
    }));
  return { channelTitle: ch.snippet.title, raw };
}

async function fetchViaInnertube() {
  const yt = await Innertube.create({ lang: 'pl', location: 'PL' });
  const resolved = await yt.resolveURL(cfg.channelUrl);
  const channelId = resolved?.payload?.browseId;
  if (!channelId) throw new Error('Nie udało się ustalić ID kanału dla ' + cfg.channelUrl);
  const channel = await yt.getChannel(channelId);
  const channelTitle = channel.metadata?.title || 'Kanał';

  let feed = await channel.getVideos();
  const listing = [];
  while (true) {
    for (const v of feed.videos) {
      const id = v.content_id ?? v.video_id ?? v.id;
      if (!id) continue;
      const title = v.metadata?.title?.text ?? v.title?.text ?? v.title ?? '';
      const parts = v.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.map(x => x.text?.text).filter(Boolean) ?? [];
      listing.push({
        id,
        title,
        order: listing.length, // 0 = najnowszy
        viewsText: parts.find(t => /wyświetl/i.test(t)) ?? '',
        publishedText: parts.find(t => !/wyświetl/i.test(t)) ?? '',
      });
    }
    if (!feed.has_continuation) break;
    feed = await feed.getContinuation();
  }
  log(`Kanał „${channelTitle}”: ${listing.length} filmów na liście. Pobieranie dokładnych liczb wyświetleń…`);

  let done = 0;
  const raw = await mapLimit(listing, cfg.concurrency ?? 4, async (v) => {
    let views = null;
    let title = v.title;
    try {
      const info = await withRetry(() => yt.getBasicInfo(v.id));
      const b = info.basic_info;
      if (typeof b.view_count === 'number') views = b.view_count;
      if (b.title) title = b.title;
    } catch (e) {
      log(`  ! ${v.id} – nie udało się pobrać szczegółów (${e.message})`);
    }
    const exact = views !== null;
    if (!exact) views = parseViewsText(v.viewsText) ?? 0;
    done++;
    if (done % 25 === 0) log(`  ${done}/${listing.length}`);
    return { id: v.id, title, views, order: v.order, publishedText: v.publishedText, exact };
  });
  return { channelTitle, raw };
}

const apiKey = process.env.YT_API_KEY;
log(apiKey ? 'Łączenie z YouTube Data API…' : 'Łączenie z YouTube (bez klucza API)…');
const { channelTitle, raw } = apiKey ? await fetchViaApi(apiKey) : await fetchViaInnertube();
const inexact = raw.filter(v => !v.exact).length;
if (inexact) log(`  UWAGA: ${inexact}/${raw.length} filmów ma zaokrąglone wyświetlenia (YouTube zablokował szczegóły). Ustaw YT_API_KEY, aby mieć dokładne liczby.`);
log(`Pobrano ${raw.length} filmów z kanału „${channelTitle}”.`);

const anchor = raw.find(v => v.id === cfg.nowStartVideoId);
if (!anchor) throw new Error(`Nie znaleziono filmu startowego „Top 10 Now” (id ${cfg.nowStartVideoId}, „${cfg.nowStartVideoTitle}”) na liście kanału.`);

const videos = raw.map(v => {
  const { artist, song } = parseTitle(v.title);
  return {
    ...v,
    artist,
    song,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    thumb: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
    excluded: isExcluded(v.title),
  };
});

// ---------- 3. notowania ----------

const byViews = (a, b) => b.views - a.views || a.order - b.order;

const allTimePool = videos.filter(v => !v.excluded);
const allTime = [...allTimePool].sort(byViews).slice(0, cfg.allTimeSize);

const nowPool = videos.filter(v => v.order <= anchor.order && (!cfg.applyExcludeToNow || !v.excluded));
const now = [...nowPool].sort(byViews).slice(0, cfg.nowSize);

// ---------- 4. historia (tygodniowe migawki) ----------

const today = new Date();
const chartDate = [today.getFullYear(), today.getMonth() + 1, today.getDate()].map(n => String(n).padStart(2, '0')).join('-'); // data lokalna
let history = { snapshots: [] };
if (fs.existsSync(p('history.json'))) {
  try { history = JSON.parse(fs.readFileSync(p('history.json'), 'utf8')); } catch { /* zaczynamy od nowa */ }
}
// ponowne uruchomienie tego samego dnia nadpisuje migawkę z tego dnia
history.snapshots = history.snapshots.filter(s => s.date !== chartDate);
const prev = history.snapshots.length ? history.snapshots[history.snapshots.length - 1] : null;

const viewsMap = Object.fromEntries(videos.map(v => [v.id, v.views]));
const snapshot = {
  date: chartDate,
  now: now.map(v => v.id),
  allTime: allTime.map(v => v.id),
  views: viewsMap,
};
history.snapshots.push(snapshot);
fs.writeFileSync(p('history.json'), JSON.stringify(history));

function enrich(list, key) {
  return list.map((v, i) => {
    const pos = i + 1;
    const prevPos = prev ? (prev[key].indexOf(v.id) + 1 || null) : null;
    let peak = pos, weeks = 0;
    for (const s of history.snapshots) {
      const idx = s[key].indexOf(v.id);
      if (idx >= 0) { weeks++; peak = Math.min(peak, idx + 1); }
    }
    const prevViews = prev?.views?.[v.id];
    return {
      pos,
      id: v.id,
      artist: v.artist,
      song: v.song,
      title: v.title,
      views: v.views,
      url: v.url,
      thumb: v.thumb,
      publishedText: v.publishedText,
      prevPos,
      move: prev ? (prevPos ? prevPos - pos : 'new') : null, // >0 w górę, <0 w dół
      peak,
      weeks,
      viewsDelta: typeof prevViews === 'number' ? v.views - prevViews : null,
    };
  });
}

const data = {
  generatedAt: today.toISOString(),
  chartDate,
  prevDate: prev?.date ?? null,
  channel: { title: channelTitle, url: cfg.channelUrl },
  config: {
    nowStart: { id: cfg.nowStartVideoId, title: anchor.title },
    excludeKeyword: cfg.excludeKeyword,
    nowSize: cfg.nowSize,
    allTimeSize: cfg.allTimeSize,
  },
  stats: {
    source: apiKey ? 'YouTube Data API' : 'youtubei.js',
    inexact,
    totalVideos: videos.length,
    excluded: videos.filter(v => v.excluded).map(v => ({ id: v.id, title: v.title })),
    nowPoolSize: nowPool.length,
    allTimePoolSize: allTimePool.length,
  },
  now: enrich(now, 'now'),
  allTime: enrich(allTime, 'allTime'),
};
fs.writeFileSync(p('data.json'), JSON.stringify(data, null, 2));

// ---------- 5. HTML ----------

const template = fs.readFileSync(p('template.html'), 'utf8');
const json = JSON.stringify(data).replace(/</g, '\\u003c');
fs.writeFileSync(p('index.html'), template.replace('/*__DATA__*/null', json));

log(`Gotowe. Notowanie z ${chartDate}: Top ${now.length} Now, Top ${allTime.length} All Time.`);
log(`Wykluczone (${data.stats.excluded.length}): ${data.stats.excluded.map(e => e.title).join(' | ') || '—'}`);
log('#1 Now: ' + (now[0] ? `${now[0].title} (${now[0].views} wyśw.)` : '—'));
log('#1 All Time: ' + (allTime[0] ? `${allTime[0].title} (${allTime[0].views} wyśw.)` : '—'));
