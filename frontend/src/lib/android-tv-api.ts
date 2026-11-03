'use client';

/**
 * Android TV 本地 API 适配层。
 * 所有 /api/* Route Handler 由本模块在 WebView 中执行；外网只用于访问用户配置的
 * CMS/M3U/EPG/推荐数据/媒体 CDN，不连接自建服务端。实际网络 I/O 经 MainActivity
 * 的 LibreTVNative.request() 在 Android 进程内完成。
 */
import {
  cmsRequestHeaders,
  filterAdultResults,
  filterRelevantResults,
  normalizeTitle,
  parseDetail,
  parseDetailPageHtml,
  parseSearchList,
} from './cms-parser';
import { parseM3u } from './m3u-parser';
import {
  describeParseStats,
  parseSubscriptionJson,
  parseSubscriptionPayload,
  withSkipped,
} from './tvbox-parser';
import type {
  BangumiCalendarResponse,
  DoubanItem,
  EpgProgram,
  LiveChannel,
  LiveEpgResponse,
  LivePlaylistResponse,
  QualityProbeItem,
  QualityProbeResult,
  SearchResponse,
  SearchResultItem,
  SearchStreamEvent,
  SourceConfig,
  SourceSearchOutcome,
  SourceListPayload,
  VideoDetail,
} from './types';

declare global {
  interface Window {
    LibreTVNative?: {
      requestAsync(url: string, method: string, headersJson: string, body: string, timeoutMs: number, callbackId: number): void;
      appVersion?: string;
    };
    __LibreTVNativeResolve?: (callbackId: number, rawResult: string) => void;
  }
}

interface LiveProbeResult {
  url: string; ok: boolean; status?: number; ms?: number; level?: 'segment' | 'manifest' | 'head';
  error?: string; codec?: string; timedOut?: boolean; kbps?: number;
}

interface NativeHttpResult {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}

interface PendingNativeRequest {
  resolve: (value: NativeHttpResult) => void;
  reject: (reason: Error) => void;
  timeoutId: number;
}

let nextNativeRequestId = 1;
const pendingNativeRequests = new Map<number, PendingNativeRequest>();

if (typeof window !== 'undefined' && !window.__LibreTVNativeResolve) {
  window.__LibreTVNativeResolve = (callbackId, rawResult) => {
    const pending = pendingNativeRequests.get(callbackId);
    if (!pending) return;
    pendingNativeRequests.delete(callbackId);
    window.clearTimeout(pending.timeoutId);
    try {
      const result = JSON.parse(rawResult) as NativeHttpResult;
      if (result.error) pending.reject(new Error(result.error));
      else pending.resolve(result);
    } catch {
      pending.reject(new Error('Android 网络桥接返回格式错误'));
    }
  };
}

const cache = new Map<string, { expires: number; value: unknown }>();
const CACHE_MAX = 400;
function getCache<T>(key: string): T | undefined {
  const v = cache.get(key);
  if (!v) return undefined;
  if (v.expires <= Date.now()) { cache.delete(key); return undefined; }
  return v.value as T;
}
function setCache(key: string, value: unknown, ttl: number): void {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, { expires: Date.now() + ttl, value });
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}
function textResponse(value: string, status = 200, contentType = 'text/plain; charset=utf-8'): Response {
  return new Response(value, { status, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' } });
}
function ndjsonResponse(run: (send: (value: unknown) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (value: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); }
        catch { closed = true; }
      };
      void run(send).then(() => {
        if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } }
      }).catch((err) => {
        send({ error: err instanceof Error ? err.message : '本地 API 处理失败' });
        if (!closed) { closed = true; try { controller.close(); } catch { /* ignore */ } }
      });
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}

function validHttpUrl(raw: string): boolean {
  try { const u = new URL(raw); return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname; }
  catch { return false; }
}

async function nativeRequest(url: string, init: RequestInit = {}, timeoutMs = 12000): Promise<Response> {
  if (!validHttpUrl(url)) throw new Error('仅允许 HTTP/HTTPS 地址');
  const native = window.LibreTVNative;
  if (!native) throw new Error('Android 网络桥接未初始化');
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = 'LibreTV Android TV/2.21.1';
  let body = '';
  if (typeof init.body === 'string') body = init.body;
  else if (init.body instanceof URLSearchParams) body = init.body.toString();
  const callbackId = nextNativeRequestId++;
  const result = await new Promise<NativeHttpResult>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      pendingNativeRequests.delete(callbackId);
      reject(new Error('网络请求超时'));
    }, Math.max(5000, timeoutMs + 7000));
    pendingNativeRequests.set(callbackId, { resolve, reject, timeoutId });
    try {
      native.requestAsync(url, init.method || 'GET', JSON.stringify(headers), body, timeoutMs, callbackId);
    } catch (err) {
      window.clearTimeout(timeoutId);
      pendingNativeRequests.delete(callbackId);
      reject(err instanceof Error ? err : new Error('无法启动 Android 网络请求'));
    }
  });
  const responseHeaders = new Headers(result.headers || {});
  const status = Math.max(200, Math.min(599, result.status || 502));
  const responseBody = (status === 204 || status === 205 || status === 304) ? null : (result.body || '');
  return new Response(responseBody, { status, headers: responseHeaders });
}

async function getJson<T>(url: string, headers: Record<string, string> = {}, timeout = 12000): Promise<T> {
  const res = await nativeRequest(url, { headers }, timeout);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as T;
}
async function getText(url: string, headers: Record<string, string> = {}, timeout = 12000): Promise<string> {
  const res = await nativeRequest(url, { headers }, timeout);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function sortAndAggregate(outcomes: SourceSearchOutcome[], wd: string, filterAdult: boolean): SearchResponse {
  const seen = new Set<string>();
  let list = outcomes.flatMap((o) => o.list).filter((item) => {
    const key = `${item.sourceKey}_${item.vodId}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  list = filterAdultResults(list, filterAdult);
  list = filterRelevantResults(list, wd);
  const exact = normalizeTitle(wd);
  list.sort((a, b) => {
    const ax = normalizeTitle(a.name || '') === exact ? 0 : 1;
    const bx = normalizeTitle(b.name || '') === exact ? 0 : 1;
    return ax - bx || (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN') || (a.sourceName || '').localeCompare(b.sourceName || '', 'zh-Hans-CN');
  });
  return { list, failures: outcomes.filter((o) => !o.ok).map((o) => ({ sourceKey: o.sourceKey, error: o.error || '请求失败', timedOut: o.timedOut })) };
}

async function searchOne(source: SourceConfig, wd: string): Promise<SourceSearchOutcome> {
  const start = Date.now();
  const finish = (x: Omit<SourceSearchOutcome, 'ms'>): SourceSearchOutcome => ({ ...x, ms: Date.now() - start });
  if (!source?.key || !source.url || !validHttpUrl(source.url)) return finish({ sourceKey: source?.key || '', ok: false, list: [], error: '无效的源地址' });
  try {
    const base = source.url.replace(/\/+$/, '');
    const firstUrl = `${base}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=1`;
    const first = await getJson<Record<string, unknown>>(firstUrl, cmsRequestHeaders(), 10000);
    const list = parseSearchList(first, source);
    const pageCountRaw = Number.parseInt(String(first.pagecount ?? '1'), 10);
    const pageCount = Math.min(Number.isFinite(pageCountRaw) ? Math.max(1, pageCountRaw) : 1, 5);
    if (pageCount > 1) {
      const pages = await Promise.all(Array.from({ length: pageCount - 1 }, async (_, i) => {
        try {
          const page = await getJson(`${base}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=${i + 2}`, cmsRequestHeaders(), 10000);
          return parseSearchList(page, source);
        } catch { return []; }
      }));
      list.push(...pages.flat());
    }
    return finish({ sourceKey: source.key, ok: true, list });
  } catch (err) {
    const message = err instanceof Error ? err.message : '请求失败';
    return finish({ sourceKey: source.key, ok: false, list: [], error: message, timedOut: /timeout|timed out|超时/i.test(message) || undefined });
  }
}

async function handleSearch(url: URL, bodyText: string): Promise<Response> {
  let body: { wd?: string; sources?: SourceConfig[]; filterAdult?: boolean };
  try { body = JSON.parse(bodyText || '{}') as typeof body; }
  catch { return jsonResponse({ error: '请求格式错误' }, 400); }
  const wd = String(body.wd || '').trim();
  if (!wd || wd.length > 100) return jsonResponse({ error: '搜索关键词无效' }, 400);
  if (!Array.isArray(body.sources) || !body.sources.length) return jsonResponse({ error: '请至少选择一个点播源' }, 400);
  const sources = body.sources.slice(0, 50);
  const filterAdult = body.filterAdult !== false;
  const key = `search:${wd}|${filterAdult}|${sources.map((s) => s.url).sort().join('|')}`;
  const cached = getCache<SearchResponse>(key);
  if (cached) {
    if (url.searchParams.get('stream') === '1') return textResponse(`${JSON.stringify({ type: 'done', list: cached.list, failures: cached.failures })}\n`, 200, 'application/x-ndjson; charset=utf-8');
    return jsonResponse(cached);
  }
  if (url.searchParams.get('stream') === '1') {
    return ndjsonResponse(async (send) => {
      const outcomes: SourceSearchOutcome[] = new Array(sources.length);
      await Promise.all(sources.map(async (source, i) => {
        const outcome = await searchOne(source, wd);
        outcomes[i] = outcome;
        send({ type: 'source', ...outcome, list: sortAndAggregate([outcome], wd, filterAdult).list } satisfies SearchStreamEvent);
      }));
      const payload = sortAndAggregate(outcomes, wd, filterAdult);
      setCache(key, payload, 60000);
      send({ type: 'done', list: payload.list, failures: payload.failures });
    });
  }
  const outcomes = await Promise.all(sources.map((s) => searchOne(s, wd)));
  const result = sortAndAggregate(outcomes, wd, filterAdult);
  setCache(key, result, 60000);
  return jsonResponse(result);
}

async function handleDetail(url: URL): Promise<Response> {
  const id = (url.searchParams.get('id') || '').trim();
  let source: SourceConfig | null = null;
  try { source = JSON.parse(url.searchParams.get('source') || 'null') as SourceConfig | null; } catch { /* invalid */ }
  if (!id || !/^[\w-]+$/.test(id)) return jsonResponse({ error: '无效的视频ID' }, 400);
  if (!source?.url || !validHttpUrl(source.url)) return jsonResponse({ error: '无效的点播源配置' }, 400);
  const key = `detail:${source.url}|${source.detail || ''}|${id}`;
  const cached = getCache<VideoDetail>(key);
  if (cached) return jsonResponse(cached);
  try {
    let detail: VideoDetail | null = null;
    const apiUrl = `${source.url.replace(/\/+$/, '')}?ac=videolist&ids=${encodeURIComponent(id)}`;
    try {
      const data = await getJson(apiUrl, cmsRequestHeaders(), 12000);
      const parsed = parseDetail(data, source);
      if (parsed.episodes.length) detail = parsed;
    } catch { /* use detail page fallback */ }
    if (!detail) {
      const detailRoot = (source.detail || url.searchParams.get('baseUrl') || new URL(source.url).origin).replace(/\/+$/, '');
      const html = await getText(`${detailRoot}/index.php/vod/detail/id/${id}.html`, { 'User-Agent': cmsRequestHeaders()['User-Agent'] }, 12000);
      detail = parseDetailPageHtml(html, source);
    }
    if (!detail || !detail.episodes.length) return jsonResponse({ error: '未找到播放资源' }, 404);
    setCache(key, detail, 60000);
    return jsonResponse(detail);
  } catch (err) { return jsonResponse({ error: err instanceof Error ? err.message : '获取详情失败' }, 502); }
}

function parseXmltvTime(raw: string): number {
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:\.(\d{1,3}))?(?:\s*([+-])(\d{2})(\d{2})|Z)?$/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, frac, sign, tzh, tzm] = m;
  const utc = Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0), +(s || 0), frac ? +frac.padEnd(3, '0') : 0);
  if (!sign) return utc;
  const offset = (+tzh * 60 + +tzm) * 60000 * (sign === '-' ? -1 : 1);
  return utc - offset;
}
function parseXmltvText(text: string, windowMs = 24 * 60 * 60 * 1000): Map<string, EpgProgram[]> {
  const map = new Map<string, EpgProgram[]>();
  const now = Date.now(); const end = now + windowMs;
  const re = /<programme\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/programme>)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const attrs: Record<string, string> = {};
    const ar = /([\w-]+)="([^"]*)"/g; let a: RegExpExecArray | null;
    while ((a = ar.exec(match[1]))) attrs[a[1].toLowerCase()] = a[2];
    const channelId = (attrs.channel || '').trim();
    const start = parseXmltvTime(attrs.start || ''); const stop = parseXmltvTime(attrs.stop || '');
    if (!channelId || !Number.isFinite(start) || !Number.isFinite(stop) || stop <= now || start >= end) continue;
    const inner = match[2] || '';
    const titleRaw = inner.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i)?.[1] || '';
    const descRaw = inner.match(/<desc(?:\s[^>]*)?>([\s\S]*?)<\/desc>/i)?.[1];
    const decode = (s: string) => s.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16))).replace(/&#(\d+);/g, (_, x) => String.fromCodePoint(parseInt(x, 10))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
    const title = decode(titleRaw); if (!title) continue;
    const item: EpgProgram = { channelId, start, stop, title, ...(descRaw ? { desc: decode(descRaw) } : {}) };
    const list = map.get(channelId) || []; list.push(item); map.set(channelId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.start - b.start);
  return map;
}
function currentNext(programs: EpgProgram[]): { current?: EpgProgram; next?: EpgProgram } {
  let current: EpgProgram | undefined; let next: EpgProgram | undefined; const now = Date.now();
  for (const p of programs) { if (p.start <= now && p.stop > now) current = p; else if (p.start > now) { next = p; break; } }
  return { current, next };
}

async function probeLive(url: string): Promise<LiveProbeResult> {
  const start = performance.now();
  try {
    if (!validHttpUrl(url)) throw new Error('无效的地址');
    const referer = `${new URL(url).origin}/`;
    const isKnownM3u = /\.m3u8?(?:$|\?)/i.test(url);
    const res = await nativeRequest(url, { headers: { Accept: '*/*', Referer: referer, ...(isKnownM3u ? {} : { Range: 'bytes=0-1' }) } }, 8000);
    const ct = res.headers.get('content-type') || '';
    const isM3u = /mpegurl/i.test(ct) || /\.m3u8?(?:$|\?)/i.test(url);
    if (!res.ok) return { url, ok: false, status: res.status, ms: Math.round(performance.now() - start), error: `HTTP ${res.status}` };
    if (!isM3u) {
      if (/text\/html|application\/json/i.test(ct)) return { url, ok: false, status: res.status, ms: Math.round(performance.now() - start), error: '返回网页或 JSON，不是媒体流' };
      return { url, ok: true, status: res.status, level: 'head', ms: Math.round(performance.now() - start) };
    }
    const text = await res.text();
    if (!text.startsWith('#EXTM3U')) return { url, ok: false, status: res.status, ms: Math.round(performance.now() - start), error: 'M3U8 格式无效' };
    const codec = text.match(/CODECS="([^"]+)"/i)?.[1];
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    let target: string | undefined;
    const idx = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
    if (idx >= 0) target = lines.slice(idx + 1).find((l) => !l.startsWith('#'));
    if (!target) target = lines.filter((l) => !l.startsWith('#')).slice(-1)[0];
    if (target) {
      const segmentUrl = new URL(target, url).href;
      const seg = await nativeRequest(segmentUrl, { headers: { Range: 'bytes=0-1', Referer: referer, Accept: '*/*' } }, 6000);
      if (!seg.ok) return { url, ok: false, status: seg.status, level: 'manifest', ms: Math.round(performance.now() - start), codec, error: `分片请求失败 ${seg.status}` };
    }
    return { url, ok: true, status: res.status, level: target ? 'segment' : 'manifest', ms: Math.round(performance.now() - start), codec };
  } catch (err) { const m = err instanceof Error ? err.message : '探测失败'; return { url, ok: false, ms: Math.round(performance.now() - start), error: m, timedOut: /timeout|超时/i.test(m) || undefined }; }
}

async function qualityProbe(item: QualityProbeItem): Promise<QualityProbeResult> {
  const { source, id } = item;
  const base = source.url.replace(/\/+$/, '');
  try {
    const data = await getJson(`${base}?ac=videolist&ids=${encodeURIComponent(id)}`, cmsRequestHeaders(), 10000);
    const detail = parseDetail(data, source);
    const episode = detail.episodes[0];
    if (!episode) return { sourceKey: source.key, vodId: id, error: '未找到播放地址' };
    if (!/\.m3u8?(?:$|[?#])/i.test(episode)) {
      const direct = await nativeRequest(episode, { headers: { Range: 'bytes=0-1', Accept: '*/*', Referer: `${new URL(episode).origin}/` } }, 8000);
      if (!direct.ok) return { sourceKey: source.key, vodId: id, error: `媒体地址 HTTP ${direct.status}` };
      return { sourceKey: source.key, vodId: id };
    }
    const playlist = await getText(episode, { Accept: '*/*', Referer: `${new URL(episode).origin}/` }, 8000);
    const heights = [...playlist.matchAll(/RESOLUTION=\d+x(\d+)/gi)].map((m) => Number(m[1])).filter((n) => n > 0);
    const bandwidths = [...playlist.matchAll(/BANDWIDTH=(\d+)/gi)].map((m) => Number(m[1]));
    const fromBandwidth = bandwidths.length ? Math.round(Math.sqrt(Math.max(...bandwidths) * 0.0005) / 10) * 10 : undefined;
    const height = heights.length ? Math.max(...heights) : fromBandwidth;
    return { sourceKey: source.key, vodId: id, height };
  } catch (err) { return { sourceKey: source.key, vodId: id, error: err instanceof Error ? err.message : '画质探测失败' }; }
}

async function fetchBangumi(): Promise<BangumiCalendarResponse> {
  const raw = await getJson<Array<{ weekday?: { id?: number }; items?: Array<{ id?: number; name?: string; name_cn?: string; images?: { large?: string; common?: string; medium?: string }; rating?: { score?: number } }> }>>('https://api.bgm.tv/calendar', { 'User-Agent': 'LibreTV Android TV/2.21.1', Accept: 'application/json' }, 12000);
  const days = raw.map((day) => ({
    weekday: Number(day.weekday?.id || 0),
    items: (day.items || []).map((s): DoubanItem | undefined => {
      const cover = s.images?.large || s.images?.common || s.images?.medium;
      const title = s.name_cn || s.name;
      if (!s.id || !cover || !title) return undefined;
      const score = s.rating?.score || 0;
      return { id: String(s.id), title, cover, rating: score > 0 ? score.toFixed(1) : undefined, isTv: true };
    }).filter((x): x is DoubanItem => !!x),
  })).filter((d) => d.weekday >= 1 && d.weekday <= 7);
  return { days };
}

const HOT_IDS = ['douban_movie_weekly', 'douban_tv_chinese', 'douban_tv_global', 'douban_show_chinese', 'douban_show_global', 'baidu_teleplay'];
async function fetchHotList(id: string): Promise<DoubanItem[]> {
  if (!HOT_IDS.includes(id)) throw new Error(`未知榜单: ${id.slice(0, 30)}`);
  const category: Record<string, string> = { douban_movie_weekly: 'movie', douban_tv_chinese: 'tv_chinese', douban_tv_global: 'tv_global', douban_show_chinese: 'show_chinese', douban_show_global: 'show_global' };
  const base = 'https://60s.crystelf.top';
  const path = category[id] ? `/v2/douban/weekly/${category[id]}` : '/v2/baidu/teleplay';
  let raw: { data?: Array<Record<string, unknown>> };
  try { raw = await getJson(`${base}${path}`, { 'User-Agent': 'LibreTV (+https://github.com/LibreSpark/LibreTV)', Accept: 'application/json' }, 10000); }
  catch { raw = await getJson(`https://60s.viki.moe${path}`, { 'User-Agent': 'LibreTV (+https://github.com/LibreSpark/LibreTV)', Accept: 'application/json' }, 10000); }
  const isTv = id !== 'douban_movie_weekly';
  return (raw.data || []).map((v, i): DoubanItem | undefined => {
    const title = String(v.title || ''); const cover = String(v.cover || v.cover_proxy || '');
    if (!title || !cover) return undefined;
    return { id: String(v.id || `baidu_${i}`), title, cover, rating: Number(v.rating) > 0 ? String(v.rating) : undefined, isTv };
  }).filter((x): x is DoubanItem => !!x);
}

async function handleApi(url: URL, method: string, bodyText: string): Promise<Response> {
  const path = url.pathname;
  if (path === '/api/status' && method === 'GET') return jsonResponse({ passwordRequired: false, verified: true, version: '2.21.1-tv', defaultSources: [], defaultLiveSources: [], defaultSubscriptions: [], defaultRecommendSource: null, defaultImageMode: null });
  if (path === '/api/auth') {
    if (method === 'GET' || method === 'DELETE') return jsonResponse({ success: true, verified: true });
    if (method === 'POST') return jsonResponse({ success: true });
  }
  if (path === '/api/search' && method === 'POST') return handleSearch(url, bodyText);
  if (path === '/api/detail' && method === 'GET') return handleDetail(url);
  if (path === '/api/source/test' && method === 'POST') {
    let data: { url?: string }; try { data = JSON.parse(bodyText) as typeof data; } catch { return jsonResponse({ error: '请求格式错误' }, 400); }
    const sourceUrl = String(data.url || '').replace(/\/+$/, ''); if (!validHttpUrl(sourceUrl)) return jsonResponse({ ok: false, ms: 0, error: '无效的源地址' });
    const start = Date.now();
    try { const raw = await getJson(`${sourceUrl}?ac=videolist&wd=test`, cmsRequestHeaders(), 8000); const list = parseSearchList(raw, { key: 'test', name: 'test', url: sourceUrl }); return jsonResponse({ ok: true, ms: Date.now() - start, count: list.length }); }
    catch (err) { return jsonResponse({ ok: false, ms: Date.now() - start, error: err instanceof Error ? err.message : '请求失败' }); }
  }
  if (path === '/api/source-list' && method === 'GET') {
    const target = url.searchParams.get('url') || ''; if (!validHttpUrl(target)) return jsonResponse({ error: '无效的订阅地址' }, 400);
    try {
      const raw = await getText(target, { Accept: 'application/json' }, 12000);
      const parsed = parseSubscriptionPayload(parseSubscriptionJson(raw));
      const sources = parsed.sources.filter((s) => validHttpUrl(s.url));
      const liveSources = parsed.liveSources.filter((s) => validHttpUrl(s.url)).map((s) => ({ ...s, epg: s.epg && validHttpUrl(s.epg) ? s.epg : undefined }));
      const dropped = parsed.sources.length - sources.length + parsed.liveSources.length - liveSources.length;
      const stats = withSkipped(parsed.stats, 'invalidUrl', dropped);
      if (!sources.length && !liveSources.length) return jsonResponse({ error: describeParseStats(stats) || '订阅内容为空' }, 400);
      return jsonResponse({ name: parsed.name, sources, liveSources, stats } satisfies SourceListPayload);
    } catch (err) { return jsonResponse({ error: err instanceof Error ? err.message : '订阅拉取失败' }, 502); }
  }
  if (path === '/api/publish' && method === 'POST') {
    let raw: Record<string, unknown>; try { raw = JSON.parse(bodyText) as Record<string, unknown>; } catch { return jsonResponse({ error: '请求内容不是合法 JSON' }, 400); }
    const asItems = (v: unknown, live = false) => (Array.isArray(v) ? v : []).slice(0, live ? 50 : 100).map((x) => x as Record<string, unknown>).filter((x) => validHttpUrl(String(x.url || ''))).map((x) => ({ name: String(x.name || '').slice(0, 128), url: String(x.url), ...(live && validHttpUrl(String(x.epg || '')) ? { epg: String(x.epg) } : {}) }));
    const sources = asItems(raw.sources); const liveSources = asItems(raw.liveSources, true);
    if (!sources.length && !liveSources.length) return jsonResponse({ error: '没有可发布的源' }, 400);
    const text = JSON.stringify({ name: String(raw.name || 'LibreTV-SourceList').slice(0, 64), version: 2, exportedAt: Date.now(), sources, liveSources }, null, 2);
    if (new TextEncoder().encode(text).length > 256 * 1024) return jsonResponse({ error: '源列表体积超出公开粘贴板限制' }, 413);
    try {
      const res = await nativeRequest('https://paste.rs/', { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8', 'User-Agent': 'LibreTV/2.21.1' }, body: text }, 15000);
      const pasted = (await res.text()).trim();
      if (res.status !== 201 || !/^https:\/\/paste\.rs\/[\w-]+$/.test(pasted)) throw new Error(`paste.rs HTTP ${res.status}`);
      return jsonResponse({ url: pasted, provider: 'paste.rs', sources: sources.length, liveSources: liveSources.length });
    } catch (err) { return jsonResponse({ error: `发布失败：${err instanceof Error ? err.message : '网络异常'}` }, 502); }
  }
  if (path === '/api/live/playlist' && method === 'GET') {
    const target = url.searchParams.get('url') || ''; if (!validHttpUrl(target)) return jsonResponse({ error: '缺少或无效的 url 参数' }, 400);
    const key = `live:playlist:${target}`; let playlist = url.searchParams.get('force') === '1' ? undefined : getCache<LivePlaylistResponse>(key);
    if (!playlist) {
      try {
        const text = await getText(target, { Accept: '*/*' }, 20000);
        const channels: LiveChannel[] = parseM3u(text, target);
        const groups = [...new Set(channels.map((c) => c.group).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b, 'zh'));
        playlist = { name: text.match(/^#PLAYLIST:(.+)$/m)?.[1]?.trim() || undefined, channels, groups };
        setCache(key, playlist, 10 * 60 * 1000);
      } catch (err) { return jsonResponse({ error: `订阅地址请求失败: ${err instanceof Error ? err.message : '未知错误'}` }, 502); }
    }
    if (url.searchParams.get('format') === 'm3u') {
      const lines = ['#EXTM3U']; if (playlist.name) lines.push(`#PLAYLIST:${playlist.name}`);
      for (const c of playlist.channels) { const attrs = [`tvg-id="${(c.tvgId || c.id).replace(/"/g, "'")}"`, c.rawName ? `tvg-name="${c.rawName.replace(/"/g, "'")}"` : '', c.logo ? `tvg-logo="${c.logo.replace(/"/g, "'")}"` : '', `group-title="${(c.group || '').replace(/"/g, "'")}"`].filter(Boolean).join(' '); lines.push(`#EXTINF:-1 ${attrs},${c.name}`, c.url); }
      return textResponse(lines.join('\n'), 200, 'audio/x-mpegurl; charset=utf-8');
    }
    return jsonResponse(playlist);
  }
  if (path === '/api/live/epg' && method === 'GET') {
    const target = url.searchParams.get('url') || ''; const channel = url.searchParams.get('channel') || '';
    if (!validHttpUrl(target) || !channel) return jsonResponse({ error: '缺少 url 或 channel 参数' }, 400);
    const key = `live:epg:${target}`; let map = url.searchParams.get('force') === '1' ? undefined : getCache<Map<string, EpgProgram[]>>(key);
    if (!map) {
      try { const text = await getText(target, { Accept: '*/*' }, 30000); map = parseXmltvText(text); setCache(key, map, 6 * 60 * 60 * 1000); }
      catch (err) { return jsonResponse({ error: `节目单地址请求失败: ${err instanceof Error ? err.message : '未知错误'}` }, 502); }
    }
    const programs = map.get(channel) || [];
    return jsonResponse({ channelId: channel, ...currentNext(programs), programs } satisfies LiveEpgResponse);
  }
  if (path === '/api/live/probe' && method === 'POST') {
    let body: { urls?: string[] }; try { body = JSON.parse(bodyText) as typeof body; } catch { return jsonResponse({ error: '请求格式错误' }, 400); }
    if (!Array.isArray(body.urls)) return jsonResponse({ error: '请提供待探测地址' }, 400);
    const urls = body.urls.filter((x) => typeof x === 'string' && validHttpUrl(x)).slice(0, 50);
    if (url.searchParams.get('stream') === '1') return ndjsonResponse(async (send) => { await Promise.all(urls.map(async (item) => send(await probeLive(item)))); });
    return jsonResponse({ results: await Promise.all(urls.map(probeLive)) });
  }
  if (path === '/api/quality' && method === 'POST') {
    let body: { items?: QualityProbeItem[] }; try { body = JSON.parse(bodyText) as typeof body; } catch { return jsonResponse({ error: '请求格式错误' }, 400); }
    const items = (Array.isArray(body.items) ? body.items : []).filter((v) => v?.source?.key && validHttpUrl(v.source.url) && typeof v.id === 'string').slice(0, 50);
    if (!items.length) return jsonResponse({ error: '请提供待探测的条目' }, 400);
    if (url.searchParams.get('stream') === '1') return ndjsonResponse(async (send) => { send({ ping: true }); for (const item of items) send(await qualityProbe(item)); });
    const results: QualityProbeResult[] = []; for (const item of items) results.push(await qualityProbe(item));
    return jsonResponse({ results });
  }
  if (path === '/api/douban' && method === 'GET') {
    const type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie'; const tag = (url.searchParams.get('tag') || '热门').slice(0, 20);
    const pageStart = Math.max(0, Number.parseInt(url.searchParams.get('pageStart') || '0', 10) || 0); const pageSize = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('pageSize') || '25', 10) || 25));
    try {
      const target = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${encodeURIComponent(tag)}&sort=recommend&page_limit=${pageSize}&page_start=${pageStart}`;
      const data = await getJson<{ subjects?: Array<{ id: string; title: string; cover: string; rate: string }> }>(target, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36', Referer: 'https://movie.douban.com/', Accept: 'application/json' }, 10000);
      return jsonResponse({ items: (data.subjects || []).map((s) => ({ id: s.id, title: s.title, cover: s.cover, rating: s.rate && s.rate !== '0' ? s.rate : undefined, isTv: type === 'tv' })) });
    } catch (err) { return jsonResponse({ error: err instanceof Error ? err.message : '豆瓣推荐获取失败' }, 502); }
  }
  if (path === '/api/bangumi/calendar' && method === 'GET') {
    try { return jsonResponse(await fetchBangumi()); } catch (err) { return jsonResponse({ error: err instanceof Error ? err.message : '新番放送表获取失败' }, 502); }
  }
  if (path === '/api/hot-list' && method === 'GET') {
    try { return jsonResponse({ items: await fetchHotList(url.searchParams.get('id') || '') }); } catch (err) { return jsonResponse({ error: err instanceof Error ? err.message : '榜单获取失败' }, 502); }
  }
  if ((path === '/api/proxy' || path.startsWith('/api/proxy/')) || (path === '/api/live/stream' || path.startsWith('/api/live/stream/'))) {
    const target = url.searchParams.get('url');
    if (target && validHttpUrl(target)) {
      try { return await nativeRequest(target, { headers: { Accept: '*/*', Referer: `${new URL(target).origin}/` } }, 30000); }
      catch (err) { return textResponse(err instanceof Error ? err.message : '代理请求失败', 502); }
    }
  }
  return jsonResponse({ error: `Android TV 本地 API 未识别：${path}` }, 404);
}

/** 仅将本地 /api/* fetch 路由至 APK 内逻辑；普通媒体 fetch 仍由 WebView 处理。 */
export async function androidTvFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : undefined;
  const requestUrl = request ? request.url : String(input);
  const url = new URL(requestUrl, window.location.href);
  const method = (init?.method || request?.method || 'GET').toUpperCase();
  let body = '';
  const sourceBody = init?.body ?? (request ? await request.clone().text() : undefined);
  if (typeof sourceBody === 'string') body = sourceBody;
  else if (sourceBody instanceof URLSearchParams) body = sourceBody.toString();

  // 在 Android 上，跨域 API 与 m3u8 文本读取统一走 APK 内原生网络层，避免 CORS 限制。
  // 视频/分片本身不从这里读取：/api/proxy 与 /api/live/stream 由 WebViewClient 流式代理。
  if (window.LibreTVNative && (url.protocol === 'http:' || url.protocol === 'https:')) {
    const headers = new Headers(init?.headers ?? request?.headers);
    const nativeInit: RequestInit = { method, headers, ...(body ? { body } : {}) };
    if (url.origin === window.location.origin && url.pathname.startsWith('/api/')) {
      try { return await handleApi(url, method, body); }
      catch (err) { return jsonResponse({ error: err instanceof Error ? err.message : 'Android TV 本地 API 错误' }, 502); }
    }
    try { return await nativeRequest(url.href, nativeInit, 15000); }
    catch (err) { return jsonResponse({ error: err instanceof Error ? err.message : '原生网络请求失败' }, 502); }
  }
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return window.fetch(input, init);
  try { return await handleApi(url, method, body); }
  catch (err) { return jsonResponse({ error: err instanceof Error ? err.message : 'Android TV 本地 API 错误' }, 502); }
}

/** 仅供集成检查使用；没有远程服务端地址。 */
export const ANDROID_TV_API_BRIDGE_READY = 'ANDROID_TV_API_BRIDGE_READY';
