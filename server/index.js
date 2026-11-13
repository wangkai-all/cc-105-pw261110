// 本地 HTTP 服务：静态页面 + JSON API。仅监听本机，不向任何外部站点发请求。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHar, paramsObject, DEFAULT_SENSITIVE_HEADERS, DEFAULT_SENSITIVE_PARAMS, DEFAULT_SENSITIVE_JSON_KEYS } from './har.js';
import { buildPagination } from './pagination.js';
import { extractRows, fingerprint, mergeFingerprints, diffFingerprints, previewRowCounts, collectArrayPaths } from './extract.js';
import { store } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SAMPLES_DIR = path.join(__dirname, '..', 'samples');
const PORT = Number(process.env.PORT || 8734);
const MAX_BODY = 512 * 1024 * 1024;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.har': 'application/json; charset=utf-8' };

function send(res, code, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
const ok = (res, data) => send(res, 200, data, { 'Content-Type': 'application/json; charset=utf-8' });
const bad = (res, msg, code = 400) => send(res, code, { error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 导入公共逻辑：解析 → 脱敏 → 入库（原始 HAR 随即丢弃）。
 *  用户配置只能追加敏感字段，默认清单（Cookie/Authorization 等）强制生效。 */
function importHarText(name, harText, source, sanitizeConfig) {
  let har;
  try { har = JSON.parse(harText); } catch { throw new Error('文件不是合法 JSON，无法作为 HAR 解析'); }
  const merge = (defs, extra) => [...new Set([...defs, ...((extra || []).map((s) => String(s).trim().toLowerCase()))])];
  const cfg = {
    headers: merge(DEFAULT_SENSITIVE_HEADERS, sanitizeConfig?.headers),
    params: merge(DEFAULT_SENSITIVE_PARAMS, sanitizeConfig?.params),
    jsonKeys: merge(DEFAULT_SENSITIVE_JSON_KEYS, sanitizeConfig?.jsonKeys),
  };
  const { entries, warnings } = parseHar(har, cfg);
  const id = store.createImport({ name, source, sanitizeConfig: cfg, warnings, entries });
  return { id, entryCount: entries.length, warnings };
}

/** 为提取准备目标请求：同 endpoint、去重（重试相同响应只取一次）、失败单列 */
function extractionTargets(importId, endpoint) {
  const entries = store.entriesForEndpoint(importId, endpoint);
  const { entryInfo } = buildPagination(entries.map((e) => ({ ...e, failed: !!e.failed })));
  const usable = [];
  const skipped = [];
  for (const e of entries) {
    const info = entryInfo.get(e.id) || {};
    if (e.failed) { skipped.push({ entryId: e.id, reason: 'failed', detail: `HTTP ${e.status} ${e.statusText}`.trim() }); continue; }
    if (info.duplicateOf) { skipped.push({ entryId: e.id, reason: 'duplicate', detail: `与请求 #${info.duplicateOf} 响应相同（重试），已去重` }); continue; }
    if (e.bodyState === 'missing') { skipped.push({ entryId: e.id, reason: 'missing', detail: 'HAR 未保存该响应体' }); continue; }
    if (e.bodyState !== 'ok' || e.body == null) { skipped.push({ entryId: e.id, reason: 'not_json', detail: `响应不是 JSON（${e.mimeType || '未知类型'}）` }); continue; }
    usable.push(e);
  }
  return { usable, skipped };
}

/** 执行提取：对目标请求逐条抽行，附加请求参数列 */
function runExtraction(entries, config) {
  const rows = [];
  const failures = [];
  const errors = new Set();
  const warnings = new Set();
  for (const e of entries) {
    const r = extractRows(e.body, config);
    r.errors.forEach((x) => errors.add(`请求 #${e.id}: ${x}`));
    r.warnings.forEach((x) => warnings.add(`请求 #${e.id}: ${x}`));
    if (r.errors.length) { failures.push({ entryId: e.id, reason: 'extract_error', detail: r.errors.join('；') }); continue; }
    const params = paramsObject(e);
    for (const row of r.rows) {
      const out = {};
      for (const pc of config.paramColumns || []) out[pc.as || `参数.${pc.param}`] = params[pc.param] ?? null;
      Object.assign(out, row);
      rows.push({ entryId: e.id, data: out });
    }
  }
  return { rows, failures, errors: [...errors], warnings: [...warnings] };
}

/** 计算某 endpoint 在新 HAR 中的结构指纹（供方案差异检查） */
function fingerprintFor(importId, endpoint, arrayPath) {
  const { usable } = extractionTargets(importId, endpoint);
  const fps = usable.map((e) => fingerprint(e.body, arrayPath)).filter(Boolean);
  return { fp: mergeFingerprints(fps), sampleCount: usable.length };
}

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/health', async () => ({ ok: true, offline: true }));

route('POST', '/api/imports', async (req, res) => {
  const body = JSON.parse(await readBody(req));
  if (!body.harText && !body.har) return bad(res, '缺少 HAR 内容');
  const harText = body.harText || JSON.stringify(body.har);
  try {
    ok(res, importHarText(body.name || '未命名导入', harText, 'upload', body.sanitizeConfig));
  } catch (e) { bad(res, e.message); }
});

route('GET', '/api/samples', async () => {
  const files = fs.existsSync(SAMPLES_DIR) ? fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.har')) : [];
  const descFile = path.join(SAMPLES_DIR, 'samples.json');
  const desc = fs.existsSync(descFile) ? JSON.parse(fs.readFileSync(descFile, 'utf8')) : {};
  return files.map((f) => ({ file: f, description: desc[f] || '' }));
});

route('POST', '/api/imports/sample', async (req, res) => {
  const { file } = JSON.parse(await readBody(req));
  const safe = path.basename(String(file || ''));
  const fp = path.join(SAMPLES_DIR, safe);
  if (!safe.endsWith('.har') || !fs.existsSync(fp)) return bad(res, '样本不存在', 404);
  try {
    ok(res, importHarText(`样本：${safe}`, fs.readFileSync(fp, 'utf8'), 'sample'));
  } catch (e) { bad(res, e.message); }
});

route('GET', '/api/imports', async () => store.listImports());

route('DELETE', '/api/imports/:id', async (req, res, p) => {
  store.deleteImport(Number(p.id));
  return { deleted: true };
});

route('GET', '/api/imports/:id/endpoints', async (req, res, p) => {
  const importId = Number(p.id);
  const entries = store.listEntries(importId, {});
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.endpoint)) groups.set(e.endpoint, { endpoint: e.endpoint, method: e.method, path: e.path, host: e.host, count: 0, ok: 0, failed: 0, missing: 0 });
    const g = groups.get(e.endpoint);
    g.count++;
    if (e.failed) g.failed++;
    else if (e.body_state === 'missing') g.missing++;
    else g.ok++;
  }
  // 分页序列（需要完整参数，含 POST 表单）
  const allEntries = store.allEntries(importId);
  const { seriesList } = buildPagination(allEntries);
  const seriesByEndpoint = {};
  for (const s of seriesList) {
    (seriesByEndpoint[s.endpoint] ||= []).push({
      seriesId: s.seriesId, fixedParams: s.fixedParams, pageParamNames: s.pageParamNames,
      total: s.total, duplicates: s.duplicates, failures: s.failures,
    });
  }
  return { endpoints: [...groups.values()], seriesByEndpoint };
});

route('GET', '/api/imports/:id/entries', async (req, res, p, query) => {
  const importId = Number(p.id);
  const entries = store.listEntries(importId, {
    endpoint: query.get('endpoint') || undefined,
    status: query.get('status') || undefined,
    state: query.get('state') || undefined,
    q: query.get('q') || undefined,
  });
  // 附带分页/去重信息
  const full = store.allEntries(importId);
  const { entryInfo } = buildPagination(full);
  return entries.map((e) => {
    const info = entryInfo.get(e.id) || {};
    return { ...e, seriesId: info.seriesId, pageParams: info.pageParams || {}, duplicateOf: info.duplicateOf || null };
  });
});

route('GET', '/api/entries/:id', async (req, res, p) => {
  const e = store.getEntry(Number(p.id));
  if (!e) return bad(res, '请求不存在', 404);
  // 数组路径建议（供点选）
  const arrayPaths = e.body ? collectArrayPaths(e.body) : [];
  return { ...e, arrayPaths };
});

route('POST', '/api/preview', async (req, res) => {
  const { importId, config } = JSON.parse(await readBody(req));
  if (!config?.endpoint || config?.arrayPath == null) return bad(res, '缺少 endpoint 或 arrayPath');
  const { usable, skipped } = extractionTargets(Number(importId), config.endpoint);
  const bodies = usable.map((e) => e.body);
  const counts = previewRowCounts(bodies, config);
  const { rows, failures, errors, warnings } = runExtraction(usable.slice(0, 20), config);
  return {
    targetCount: usable.length,
    skipped,
    baseRows: counts.baseRows,
    expandedRows: counts.expandedRows,
    rowDelta: counts.expandedRows - counts.baseRows,
    errors: [...new Set([...counts.errors, ...errors])],
    warnings: [...new Set([...counts.warnings, ...warnings])],
    failures,
    sampleRows: rows.slice(0, 50).map((r) => r.data),
    columns: rows[0] ? Object.keys(rows[0].data) : (config.fields || []).map((f) => f.as || f.path),
  };
});

route('POST', '/api/extract', async (req, res) => {
  const { name, importId, config, schemeId } = JSON.parse(await readBody(req));
  if (!config?.endpoint || config?.arrayPath == null) return bad(res, '缺少 endpoint 或 arrayPath');
  const { usable, skipped } = extractionTargets(Number(importId), config.endpoint);
  const { rows, failures, errors, warnings } = runExtraction(usable, config);
  const allFailures = [
    ...skipped.map((s) => ({ entryId: s.entryId, reason: s.reason, detail: s.detail })),
    ...failures,
  ];
  const stats = { targets: usable.length, rows: rows.length, skipped: skipped.length, errors, warnings };
  const id = store.createDataset({ name: name || `提取 ${config.endpoint}`, schemeId, importId: Number(importId), stats, rows, failures: allFailures });
  return { datasetId: id, stats };
});

route('GET', '/api/datasets', async () => store.listDatasets());

route('GET', '/api/datasets/:id', async (req, res, p, query) => {
  const d = store.getDataset(Number(p.id), Number(query.get('offset') || 0), Math.min(Number(query.get('limit') || 200), 1000));
  if (!d) return bad(res, '数据集不存在', 404);
  return d;
});

route('GET', '/api/datasets/:id/export', async (req, res, p, query) => {
  const d = store.getDataset(Number(p.id));
  if (!d) return bad(res, '数据集不存在', 404);
  const rows = store.datasetRows(Number(p.id));
  const format = query.get('format') || 'csv';
  const name = `dataset-${p.id}.${format === 'json' ? 'json' : 'csv'}`;
  if (format === 'json') {
    send(res, 200, JSON.stringify(rows, null, 2), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
    return;
  }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
});

route('DELETE', '/api/datasets/:id', async (req, res, p) => {
  store.deleteDataset(Number(p.id));
  return { deleted: true };
});

route('GET', '/api/schemes', async () => store.listSchemes());

route('POST', '/api/schemes', async (req, res) => {
  const { id, name, config, importId } = JSON.parse(await readBody(req));
  if (!name || !config?.endpoint || config?.arrayPath == null) return bad(res, '方案需要名称、endpoint 与 arrayPath');
  // 保存时记录结构指纹（基于当前 HAR）
  let fp = null;
  if (importId) {
    const r = fingerprintFor(Number(importId), config.endpoint, config.arrayPath);
    fp = r.fp ? { ...r.fp, endpoint: config.endpoint, arrayPath: config.arrayPath } : null;
  }
  const schemeId = store.saveScheme({ id, name, config, fingerprint: fp });
  return { id: schemeId, fingerprint: fp };
});

route('GET', '/api/schemes/:id', async (req, res, p) => {
  const s = store.getScheme(Number(p.id));
  if (!s) return bad(res, '方案不存在', 404);
  return s;
});

route('DELETE', '/api/schemes/:id', async (req, res, p) => {
  store.deleteScheme(Number(p.id));
  return { deleted: true };
});

// 结构差异检查：方案指纹 vs 目标 HAR 实际结构
route('POST', '/api/schemes/:id/check', async (req, res, p) => {
  const scheme = store.getScheme(Number(p.id));
  if (!scheme) return bad(res, '方案不存在', 404);
  const { importId } = JSON.parse(await readBody(req));
  const cfg = scheme.config;
  const entries = store.entriesForEndpoint(Number(importId), cfg.endpoint);
  if (entries.length === 0) {
    return { ok: false, reason: `目标 HAR 中不存在接口 ${cfg.endpoint}`, diff: null };
  }
  const { fp, sampleCount } = fingerprintFor(Number(importId), cfg.endpoint, cfg.arrayPath);
  if (!fp) {
    return { ok: false, reason: `目标 HAR 的响应中找不到数组路径 ${cfg.arrayPath}（可能响应体缺失或结构变化）`, diff: null, sampleCount };
  }
  const base = scheme.fingerprint;
  if (!base) return { ok: true, diff: null, note: '方案未记录结构指纹，无法对比', sampleCount };
  const diff = diffFingerprints(base, fp);
  // 方案引用但新结构缺失的输出字段
  const missingFields = (cfg.fields || []).filter((f) => diff.removed.some((r) => r === f.path || f.path.startsWith(r + '.')));
  return { ok: diff.compatible, diff, missingFields: missingFields.map((f) => f.path), sampleCount };
});

route('POST', '/api/schemes/:id/execute', async (req, res, p) => {
  const scheme = store.getScheme(Number(p.id));
  if (!scheme) return bad(res, '方案不存在', 404);
  const { importId, name } = JSON.parse(await readBody(req));
  const cfg = scheme.config;
  const { usable, skipped } = extractionTargets(Number(importId), cfg.endpoint);
  const { rows, failures, errors, warnings } = runExtraction(usable, cfg);
  const allFailures = [...skipped, ...failures];
  const stats = { targets: usable.length, rows: rows.length, skipped: skipped.length, errors, warnings, schemeId: scheme.id };
  const id = store.createDataset({ name: name || `${scheme.name} @ 导入#${importId}`, schemeId: scheme.id, importId: Number(importId), stats, rows, failures: allFailures });
  return { datasetId: id, stats };
});

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = u.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const result = await r.handler(req, res, params, u.searchParams);
        if (!res.writableEnded) ok(res, result ?? {});
        return;
      }
      return bad(res, '接口不存在', 404);
    }
    // 静态文件
    let fp = path.normalize(path.join(PUBLIC_DIR, u.pathname === '/' ? 'index.html' : u.pathname));
    if (!fp.startsWith(PUBLIC_DIR) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(PUBLIC_DIR, 'index.html');
    send(res, 200, fs.readFileSync(fp), { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  } catch (e) {
    if (!res.writableEnded) bad(res, e.message || '服务器错误', 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`HAR 提取工具已启动: http://127.0.0.1:${PORT} （仅本机访问，不向外部站点发送请求）`);
});
