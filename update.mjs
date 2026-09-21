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

function isExcluded(title, artist = '') {
  const norm = title.normalize('NFKC');
  const kw = cfg.excludeKeyword || '';
  if (kw && (cfg.excludeCaseSensitive ? norm.includes(kw) : norm.toLowerCase().includes(kw.toLowerCase()))) return true;
  // wykonawcy spoza wytwórni (config.excludeArtists) – dopasowanie bez rozróżniania wielkości liter,
  // w polu wykonawcy albo w całym tytule (np. featuringi)
  for (const a of cfg.excludeArtists ?? []) {
    const needle = a.normalize('NFKC').toLowerCase();
    if (artist.normalize('NFKC').toLowerCase().includes(needle) || norm.toLowerCase().includes(needle)) return true;
  }
  return false;
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

  // Playlista „uploads” zawiera też Shorts, których zakładka „Filmy” nie pokazuje – odfiltrowujemy je.
  // Test: /shorts/ID odpowiada 200 dla Shortsa, a zwykły film przekierowuje (303) na /watch.
  // Wynik zapisujemy w shorts-cache.json, więc co tydzień sprawdzane są tylko nowe filmy.
  const cachePath = p('shorts-cache.json');
  let shortsCache = {};
  if (fs.existsSync(cachePath)) { try { shortsCache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* od nowa */ } }
  const unknown = items.filter(v => stats[v.id] && !(v.id in shortsCache));
  if (unknown.length) log(`  Sprawdzanie, które z ${unknown.length} nowych filmów to Shorts…`);
  await mapLimit(unknown, cfg.concurrency ?? 4, async (v) => {
    try {
      const r = await withRetry(() => fetch(`https://www.youtube.com/shorts/${v.id}`, {
        method: 'HEAD', redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0', cookie: 'SOCS=CAI; CONSENT=YES+cb' },
      }));
      if (r.status === 200) shortsCache[v.id] = true;
      else if (r.status >= 300 && r.status < 400 && /\/watch/.test(r.headers.get('location') ?? '')) shortsCache[v.id] = false;
      else log(`  ! ${v.id} – nietypowa odpowiedź ${r.status} przy sprawdzaniu Shorts; traktuję jako zwykły film`);
    } catch (e) {
      log(`  ! ${v.id} – nie udało się sprawdzić Shorts (${e.message}); traktuję jako zwykły film`);
    }
  });
  fs.writeFileSync(cachePath, JSON.stringify(shortsCache));
  const shorts = items.filter(v => shortsCache[v.id] === true);
  log(`  Pominięto ${shorts.length} Shorts.`);

  const raw = items
    .filter(v => stats[v.id] && shortsCache[v.id] !== true) // pomija filmy niedostępne publicznie i Shorts
    .map((v, order) => ({
      id: v.id,
      title: stats[v.id].title ?? v.title,
      views: stats[v.id].views,
      order,
      publishedAt: v.publishedAt ?? null,
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
    return { id: v.id, title, views, order: v.order, publishedAt: null, publishedText: v.publishedText, exact };
  });
  return { channelTitle, raw };
}

// klucz: zmienna środowiskowa YT_API_KEY (GitHub Actions – sekret) albo lokalny plik .ytkey (poza gitem)
const apiKey = process.env.YT_API_KEY || (fs.existsSync(p('.ytkey')) ? fs.readFileSync(p('.ytkey'), 'utf8').trim() : '');
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
    excluded: isExcluded(v.title, artist),
  };
});

// ---------- 3. notowania ----------

const byViews = (a, b) => b.views - a.views || a.order - b.order;

const allTimePool = videos.filter(v => !v.excluded);
const allTime = [...allTimePool].sort(byViews).slice(0, cfg.allTimeSize);

const nowPool = videos.filter(v => v.order <= anchor.order && (!cfg.applyExcludeToNow || !v.excluded));
const now = [...nowPool].sort(byViews).slice(0, cfg.nowSize);

// najnowsze wydania: od najnowszego (order rośnie = starsze), bez wykluczonych
const latest = videos.filter(v => !v.excluded).sort((a, b) => a.order - b.order).slice(0, cfg.latestSize ?? 10);
const latestIds = new Set(latest.map(v => v.id));

// ---------- 4. historia (codzienne migawki, porównanie tydzień do tygodnia) ----------

const today = new Date();
const isoDate = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].map(n => String(n).padStart(2, '0')).join('-'); // data lokalna
const chartDate = isoDate(today);
const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return isoDate(d); };
const isoWeek = (dateStr) => { // "RRRR-Www" – do liczenia tygodni w notowaniu
  const d = new Date(dateStr + 'T00:00:00Z'); const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = d.getUTCFullYear(); const w = Math.ceil(((d - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
};

let history = { snapshots: [] };
if (fs.existsSync(p('history.json'))) {
  try { history = JSON.parse(fs.readFileSync(p('history.json'), 'utf8')); } catch { /* zaczynamy od nowa */ }
}
// ponowne uruchomienie tego samego dnia nadpisuje migawkę z tego dnia
history.snapshots = history.snapshots.filter(s => s.date !== chartDate).sort((a, b) => a.date.localeCompare(b.date));

// punkt odniesienia dla strzałek ▲▼: ostatnia migawka sprzed co najmniej 7 dni;
// jeśli historia jest krótsza – najstarsza dostępna (czyli „od startu”)
const weekAgo = daysAgo(7);
const older = history.snapshots.filter(s => s.date <= weekAgo);
const prev = older.length ? older[older.length - 1] : (history.snapshots[0] ?? null);

// ---------- rosnące: utwory z największym przyrostem wyświetleń tydz./tydz. ----------
const gainCandidates = allTimePool
  .map(v => ({ v, delta: prev?.views?.[v.id] != null ? v.views - prev.views[v.id] : null }))
  .filter(x => x.delta !== null && x.delta > 0)
  .sort((a, b) => b.delta - a.delta)
  .slice(0, cfg.risingSize ?? 8)
  .map(x => x.v);

// ---------- ekipa: ranking wykonawców po sumie wyświetleń w całym katalogu (bez wykluczeń) ----------
function splitArtists(name) {
  return (name || '').split(/\s*,\s*|\s+&\s+|\s+x\s+|\s+\+\s+|\s+ft\.?\s+|\s+feat\.?\s+/i).map(s => s.trim()).filter(Boolean);
}
const artistMap = new Map();
for (const v of videos.filter(v => !v.excluded)) {
  const names = splitArtists(v.artist).length ? splitArtists(v.artist) : [v.artist || 'Nieznany'];
  for (const name of names) {
    if (!artistMap.has(name)) artistMap.set(name, { name, views: 0, songs: 0, best: null });
    const a = artistMap.get(name);
    a.views += v.views;
    a.songs += 1;
    if (!a.best || v.views > a.best.views) a.best = v;
  }
}
const artists = [...artistMap.values()]
  .sort((a, b) => b.views - a.views || b.songs - a.songs)
  .slice(0, cfg.artistsSize ?? 10)
  .map((a, i) => ({
    pos: i + 1, name: a.name, views: a.views, songs: a.songs,
    bestSong: a.best.song, bestArtist: a.best.artist, bestThumb: a.best.thumb, bestUrl: a.best.url,
  }));

const catalog = videos.filter(v => !v.excluded);
const totals = { views: catalog.reduce((s, v) => s + v.views, 0), songs: catalog.length };

const viewsMap = Object.fromEntries(videos.map(v => [v.id, v.views]));
const snapshot = {
  date: chartDate,
  now: now.map(v => v.id),
  allTime: allTime.map(v => v.id),
  rising: gainCandidates.map(v => v.id),
  views: viewsMap,
};
history.snapshots.push(snapshot);

// przycinanie: ostatnie 60 dni co dzień, starsze – jedna migawka na tydzień
const keepFrom = daysAgo(60);
const seenWeeks = new Set();
history.snapshots = history.snapshots.filter(s => {
  if (s.date >= keepFrom) return true;
  const w = isoWeek(s.date);
  if (seenWeeks.has(w)) return false;
  seenWeeks.add(w); return true;
});
fs.writeFileSync(p('history.json'), JSON.stringify(history));

function enrich(list, key) {
  return list.map((v, i) => {
    const pos = i + 1;
    const prevPos = prev ? ((prev[key] ?? []).indexOf(v.id) + 1 || null) : null;
    let peak = pos; const weekSet = new Set();
    for (const s of history.snapshots) {
      const idx = (s[key] ?? []).indexOf(v.id);
      if (idx >= 0) { weekSet.add(isoWeek(s.date)); peak = Math.min(peak, idx + 1); }
    }
    const weeks = weekSet.size;
    const prevViews = prev?.views?.[v.id];
    return {
      pos,
      id: v.id,
      isLatest: latestIds.has(v.id), // jeden z N najnowszych numerów na kanale (znacznik NEW)
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
  rising: enrich(gainCandidates, 'rising'),
  artists,
  totals,
  latest: latest.map(v => ({
    id: v.id, artist: v.artist, song: v.song, title: v.title, views: v.views, url: v.url, thumb: v.thumb,
    thumbLarge: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    publishedAt: v.publishedAt, publishedText: v.publishedText,
    isNew: v.publishedAt ? (today - new Date(v.publishedAt)) < 7 * 864e5 : false, // z ostatnich 7 dni
    viewsDelta: typeof prev?.views?.[v.id] === 'number' ? v.views - prev.views[v.id] : null,
  })),
};
fs.writeFileSync(p('data.json'), JSON.stringify(data, null, 2));

// ---------- 5. HTML ----------

const template = fs.readFileSync(p('template.html'), 'utf8');
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const build = data.generatedAt; // identyfikator wersji – strona porównuje go z version.json i przeładowuje się, gdy przeglądarka trzyma starą kopię
fs.writeFileSync(p('index.html'), template.replace('/*__DATA__*/null', json).replaceAll('__BUILD__', build));
fs.writeFileSync(p('version.json'), JSON.stringify({ build }));

log(`Gotowe. Notowanie z ${chartDate}: Top ${now.length} Now, Top ${allTime.length} All Time, ${latest.length} najnowszych wydań, ${data.rising.length} rosnących, ${artists.length} w Ekipie (odniesienie: ${prev?.date ?? '—'}).`);
log(`Wykluczone (${data.stats.excluded.length}): ${data.stats.excluded.map(e => e.title).join(' | ') || '—'}`);
log('#1 Now: ' + (now[0] ? `${now[0].title} (${now[0].views} wyśw.)` : '—'));
log('#1 All Time: ' + (allTime[0] ? `${allTime[0].title} (${allTime[0].views} wyśw.)` : '—'));
