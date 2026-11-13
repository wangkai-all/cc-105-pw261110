// 分页序列识别：按“实际参数”关联同一接口的翻页请求。
// 规则：同一 endpoint 下，除分页参数外其余参数完全一致的请求归为同一序列；
// 分页参数 = 常见翻页参数名，或“在组内取值变化且为数字/游标”的参数。
import { paramsObject } from './har.js';

const PAGEISH = /^(page|p|page_?num|page_?no|pageindex|page_?index|offset|cursor|start|after|since|next|page_?token|page_?size|per_?page|limit|size|count)$/i;

export function buildPagination(entries) {
  // 归一化字段（兼容 camelCase 与数据库 snake_case 行）
  const norm = entries.map((e) => ({
    ...e,
    startedAt: e.startedAt ?? e.started_at ?? '',
    bodyHash: e.bodyHash ?? e.body_hash ?? null,
    failed: !!(e.failed),
    bodyState: e.bodyState ?? e.body_state,
  }));
  const byEndpoint = new Map();
  for (const e of norm) {
    if (!byEndpoint.has(e.endpoint)) byEndpoint.set(e.endpoint, []);
    byEndpoint.get(e.endpoint).push(e);
  }
  const seriesList = [];
  const entryInfo = new Map(); // entryId -> {seriesId, pageParam, duplicateOf, failed}

  for (const [endpoint, group] of byEndpoint) {
    const paramNames = new Set();
    const withParams = group.map((e) => ({ e, params: paramsObject(e) }));
    for (const { params } of withParams) Object.keys(params).forEach((k) => paramNames.add(k));

    // 判定分页参数：组内取值变化，且名字像翻页或为数字/游标；恒定参数留在关联键里
    const pageParams = new Set();
    for (const name of paramNames) {
      const values = new Set(withParams.map(({ params }) => params[name] ?? ''));
      if (values.size <= 1) continue;
      if (PAGEISH.test(name) || withParams.every(({ params }) => /^\d+$/.test(params[name] ?? ''))) {
        pageParams.add(name);
      }
    }

    // 序列键 = endpoint + 除分页参数外的参数
    const bySeries = new Map();
    for (const item of withParams) {
      const rest = Object.fromEntries(
        Object.entries(item.params).filter(([k]) => !pageParams.has(k)).sort(([a], [b]) => a.localeCompare(b))
      );
      const key = JSON.stringify(rest);
      if (!bySeries.has(key)) bySeries.set(key, []);
      bySeries.get(key).push(item);
    }

    let seq = 0;
    for (const [restKey, list] of bySeries) {
      const seriesId = `${endpoint}#${seq++}`;
      list.sort((a, b) => String(a.e.startedAt).localeCompare(String(b.e.startedAt)));
      const seenHash = new Map();
      const pages = [];
      for (const { e, params } of list) {
        const pageVals = Object.fromEntries([...pageParams].filter((k) => k in params).map((k) => [k, params[k]]));
        let duplicateOf = null;
        if (e.bodyHash && seenHash.has(e.bodyHash)) duplicateOf = seenHash.get(e.bodyHash);
        else if (e.bodyHash) seenHash.set(e.bodyHash, e.id);
        const info = {
          seriesId,
          pageParams: pageVals,
          duplicateOf,
          failed: e.failed,
        };
        entryInfo.set(e.id, info);
        pages.push({ entryId: e.id, ...info, startedAt: e.startedAt, status: e.status, bodyState: e.bodyState });
      }
      seriesList.push({
        seriesId,
        endpoint,
        fixedParams: JSON.parse(restKey),
        pageParamNames: [...pageParams],
        total: pages.length,
        duplicates: pages.filter((p) => p.duplicateOf).length,
        failures: pages.filter((p) => p.failed).length,
        pages,
      });
    }
  }
  return { seriesList, entryInfo };
}
