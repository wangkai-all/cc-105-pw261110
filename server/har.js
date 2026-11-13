// HAR 解析与脱敏。脱敏在导入边界一次性完成：原始 HAR 不入库，
// 页面、导出、持久化记录都只接触脱敏后的数据。
import { createHash } from 'node:crypto';

export const DEFAULT_SENSITIVE_HEADERS = [
  'cookie', 'set-cookie', 'authorization', 'proxy-authorization',
  'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token', 'x-session-token',
];

export const DEFAULT_SENSITIVE_PARAMS = [
  'token', 'access_token', 'refresh_token', 'id_token', 'sessionid', 'session_id',
  'api_key', 'apikey', 'auth', 'signature', 'sig', 'secret', 'password', 'passwd',
];

export const DEFAULT_SENSITIVE_JSON_KEYS = [
  'token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token',
  'sessionId', 'sessionid', 'secret', 'password', 'authorization', 'cookie',
];

export function defaultSanitizeConfig() {
  return {
    headers: [...DEFAULT_SENSITIVE_HEADERS],
    params: [...DEFAULT_SENSITIVE_PARAMS],
    jsonKeys: [...DEFAULT_SENSITIVE_JSON_KEYS],
  };
}

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

function lcSet(list) {
  return new Set((list || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
}

/** 递归移除 JSON 中的敏感键（键名大小写不敏感） */
export function scrubJson(value, keySet) {
  if (Array.isArray(value)) return value.map((v) => scrubJson(v, keySet));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (keySet.has(k.toLowerCase())) continue;
      out[k] = scrubJson(v, keySet);
    }
    return out;
  }
  return value;
}

function sanitizeHeaders(headers, headerSet) {
  return (headers || [])
    .filter((h) => h && h.name && !headerSet.has(h.name.toLowerCase()))
    .map((h) => ({ name: h.name, value: String(h.value ?? '') }));
}

function sanitizeNameValues(list, paramSet) {
  return (list || [])
    .filter((p) => p && p.name && !paramSet.has(p.name.toLowerCase()))
    .map((p) => ({ name: p.name, value: String(p.value ?? '') }));
}

/**
 * 解析并脱敏整个 HAR。
 * 返回 { entries: [...], warnings: [...] }，每个 entry 已展开为存储行。
 * 响应体处理规则：
 *  - content.encoding === 'base64' → 解码为 utf8 文本；
 *  - 无 content.text（或为空且 size>0）→ bodyState='missing'，明确标记缺失，不补造；
 *  - 非 JSON → bodyState='not_json'，保留文本截断预览。
 */
export function parseHar(har, sanitizeConfig = defaultSanitizeConfig()) {
  const headerSet = lcSet(sanitizeConfig.headers);
  const paramSet = lcSet(sanitizeConfig.params);
  const jsonKeySet = lcSet(sanitizeConfig.jsonKeys);
  const warnings = [];

  const rawEntries = har?.log?.entries;
  if (!Array.isArray(rawEntries)) throw new Error('不是合法的 HAR 文件：缺少 log.entries');

  /** 重建 URL：剔除敏感查询参数，保证持久化的 url 不含敏感值 */
  const sanitizeUrl = (rawUrl) => {
    const u = safeUrl(rawUrl);
    if (!u) return String(rawUrl || '').replace(/([?&])([^=&]+)=([^&]*)/g,
      (m, sep, k, v) => (paramSet.has(k.toLowerCase()) ? `${sep}${k}=<已清除>` : m));
    for (const k of [...u.searchParams.keys()]) {
      if (paramSet.has(k.toLowerCase())) u.searchParams.set(k, '<已清除>');
    }
    return u.toString();
  };

  /** 非 JSON 请求体文本中的 name=value 敏感参数打码 */
  const scrubTextParams = (text) => String(text).replace(/([?&\s]|^)([^=&\s]+)=([^&\s]*)/g,
    (m, sep, k, v) => (paramSet.has(k.toLowerCase()) ? `${sep}${k}=<已清除>` : m));

  const entries = rawEntries.map((e, idx) => {
    const req = e.request || {};
    const res = e.response || {};
    const url = safeUrl(req.url);
    const cleanUrl = sanitizeUrl(req.url);
    const query = sanitizeNameValues(req.queryString || [], paramSet);
    // URL 上自带但 queryString 未列出的参数也要脱敏后保留
    const urlQuery = url
      ? [...url.searchParams.entries()]
          .filter(([k]) => !paramSet.has(k.toLowerCase()))
          .map(([name, value]) => ({ name, value }))
      : [];
    const mergedQuery = query.length ? query : urlQuery;

    // 请求体
    let postParams = [];
    let postTextState = 'none';
    if (req.postData) {
      postParams = sanitizeNameValues(req.postData.params || [], paramSet);
      if (req.postData.text) {
        postTextState = 'ok';
        const parsed = tryJson(req.postData.text);
        if (parsed.ok) {
          req._scrubbedPost = JSON.stringify(scrubJson(parsed.value, jsonKeySet));
        } else {
          req._scrubbedPost = scrubTextParams(req.postData.text).slice(0, 2000);
        }
      } else if ((req.postData.size || 0) > 0) {
        postTextState = 'missing';
      }
    }

    // 响应体
    const content = res.content || {};
    let bodyState = 'empty';
    let bodyText = null;
    let bodyJson = null;
    if (typeof content.text === 'string' && content.text.length > 0) {
      let text = content.text;
      if (content.encoding === 'base64') {
        try {
          text = Buffer.from(content.text, 'base64').toString('utf8');
        } catch {
          bodyState = 'decode_error';
          warnings.push(`第 ${idx + 1} 条响应 base64 解码失败`);
        }
      }
      if (bodyState !== 'decode_error') {
        const parsed = tryJson(text);
        if (parsed.ok) {
          bodyJson = scrubJson(parsed.value, jsonKeySet);
          bodyText = JSON.stringify(bodyJson);
          bodyState = 'ok';
        } else {
          bodyText = text.slice(0, 5000);
          bodyState = 'not_json';
        }
      }
    } else if ((content.size || 0) > 0 || (res.status >= 200 && res.status !== 204)) {
      // HAR 未保存响应体：明确标记缺失，绝不补造
      bodyState = 'missing';
      warnings.push(`第 ${idx + 1} 条（${req.method || '?'} ${url?.pathname || cleanUrl || '?'}）响应体未保存`);
    }

    const status = res.status ?? 0;
    const failed = status === 0 || status >= 400;
    const entry = {
      idx,
      startedAt: e.startedDateTime || null,
      timeMs: Math.round(e.time ?? 0),
      method: (req.method || 'GET').toUpperCase(),
      url: cleanUrl,
      host: url?.host || '',
      path: url?.pathname || '',
      endpoint: `${(req.method || 'GET').toUpperCase()} ${url?.pathname || cleanUrl}`,
      query: mergedQuery,
      requestHeaders: sanitizeHeaders(req.headers, headerSet),
      postParams,
      postText: req._scrubbedPost ?? null,
      postTextState,
      status,
      statusText: res.statusText || '',
      failed,
      mimeType: content.mimeType || '',
      responseHeaders: sanitizeHeaders(res.headers, headerSet),
      bodyState,
      bodyText,
      bodyHash: bodyText ? sha1(bodyText) : null,
    };
    delete req._scrubbedPost;
    return entry;
  });

  return { entries, warnings };
}

function tryJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function safeUrl(u) {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

/** 请求参数（查询串 + 表单）合并为对象，供分页关联与参数列使用 */
export function paramsObject(entry) {
  const out = {};
  for (const p of entry.query || []) out[p.name] = p.value;
  for (const p of entry.postParams || []) out[p.name] = p.value;
  return out;
}
