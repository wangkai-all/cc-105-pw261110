import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, getByPath, extractRows, fingerprint, diffFingerprints, previewRowCounts } from '../server/extract.js';
import { parseHar, defaultSanitizeConfig, paramsObject } from '../server/har.js';
import { buildPagination } from '../server/pagination.js';

/* ---------- 路径 ---------- */
test('parsePath / getByPath', () => {
  assert.deepEqual(parsePath('a.b[0].c'), ['a', 'b', 0, 'c']);
  assert.equal(getByPath({ a: { b: [{ c: 7 }] } }, parsePath('a.b[0].c')), 7);
  assert.equal(getByPath({}, parsePath('x.y')), undefined);
});

/* ---------- HAR 解析与脱敏 ---------- */
const SECRET = 'SECRET-TOKEN-123';
function fakeHar(entries) {
  return { log: { version: '1.2', creator: { name: 't', version: '1' }, entries } };
}
function fakeEntry(over = {}) {
  return {
    startedDateTime: '2026-11-10T09:00:00.000Z',
    time: 10,
    request: {
      method: 'GET',
      url: `https://api.example.com/list?page=1&access_token=${SECRET}`,
      headers: [
        { name: 'Cookie', value: 'sessionid=abc' },
        { name: 'Authorization', value: `Bearer ${SECRET}` },
        { name: 'Accept', value: 'application/json' },
      ],
      queryString: [
        { name: 'page', value: '1' },
        { name: 'access_token', value: SECRET },
      ],
      ...over.request,
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: [{ name: 'Set-Cookie', value: 'sessionid=abc' }, { name: 'Content-Type', value: 'application/json' }],
      content: { size: 10, mimeType: 'application/json', text: JSON.stringify({ ok: 1, token: SECRET }) },
      ...over.response,
    },
  };
}

test('导入时清除 Cookie/Authorization/敏感参数/敏感JSON键', () => {
  const { entries } = parseHar(fakeHar([fakeEntry()]), defaultSanitizeConfig());
  const e = entries[0];
  const allHeaderNames = [...e.requestHeaders, ...e.responseHeaders].map((h) => h.name.toLowerCase());
  assert.ok(!allHeaderNames.includes('cookie'));
  assert.ok(!allHeaderNames.includes('authorization'));
  assert.ok(!allHeaderNames.includes('set-cookie'));
  assert.ok(allHeaderNames.includes('accept'));
  assert.deepEqual(e.query, [{ name: 'page', value: '1' }]);
  assert.equal(JSON.stringify(e).includes(SECRET), false, '存储记录不得包含敏感值');
});

test('base64 响应体正确解码', () => {
  const body = { code: 0, list: [1, 2] };
  const entry = fakeEntry({
    response: {
      status: 200, statusText: 'OK', headers: [],
      content: { size: 10, mimeType: 'application/json', text: Buffer.from(JSON.stringify(body)).toString('base64'), encoding: 'base64' },
    },
  });
  const { entries } = parseHar(fakeHar([entry]));
  assert.equal(entries[0].bodyState, 'ok');
  assert.deepEqual(JSON.parse(entries[0].bodyText), body);
});

test('响应体缺失明确标记，不补造数据', () => {
  const entry = fakeEntry({ response: { status: 200, statusText: 'OK', headers: [], content: { size: 999, mimeType: 'application/json' } } });
  const { entries, warnings } = parseHar(fakeHar([entry]));
  assert.equal(entries[0].bodyState, 'missing');
  assert.equal(entries[0].bodyText, null);
  assert.ok(warnings.some((w) => w.includes('响应体未保存')));
});

test('失败响应标记 failed', () => {
  const e500 = fakeEntry({ response: { status: 500, statusText: 'ISE', headers: [], content: { size: 2, text: '{}' } } });
  const { entries } = parseHar(fakeHar([e500]));
  assert.equal(entries[0].failed, true);
});

/* ---------- 分页关联与去重 ---------- */
test('分页按实际参数关联；相同响应去重；失败单列', () => {
  const mk = (id, page, body, status = 200) => ({
    id, endpoint: 'GET /api/list', startedAt: `2026-11-10T09:00:0${id}.000Z`,
    query: [{ name: 'page', value: String(page) }, { name: 'cat', value: 'book' }],
    postParams: [], status, failed: status >= 400, bodyHash: body, bodyState: 'ok',
  });
  const entries = [
    mk(1, 1, 'hashA'), mk(2, 2, 'hashB'), mk(3, 2, 'hashB'), // 3 是 2 的重试
    mk(4, 3, 'hashE', 500),                                    // 失败
  ];
  const { seriesList, entryInfo } = buildPagination(entries);
  assert.equal(seriesList.length, 1);
  assert.deepEqual(seriesList[0].pageParamNames, ['page']);
  assert.deepEqual(seriesList[0].fixedParams, { cat: 'book' });
  assert.equal(entryInfo.get(3).duplicateOf, 2);
  assert.equal(entryInfo.get(4).failed, true);
  assert.equal(entryInfo.get(1).duplicateOf, null);
});

test('不同过滤参数分为不同序列', () => {
  const mk = (id, page, cat) => ({
    id, endpoint: 'GET /api/list', startedAt: `2026-11-10T09:00:0${id}.000Z`,
    query: [{ name: 'page', value: String(page) }, { name: 'cat', value: cat }],
    postParams: [], status: 200, failed: false, bodyHash: `h${id}`, bodyState: 'ok',
  });
  const { seriesList } = buildPagination([mk(1, 1, 'book'), mk(2, 2, 'book'), mk(3, 1, 'food')]);
  assert.equal(seriesList.length, 2);
});

/* ---------- 提取与嵌套展开 ---------- */
const body = {
  data: {
    list: [
      { id: 'A', total: 10, items: [{ sku: 's1', qty: 1 }, { sku: 's2', qty: 2 }] },
      { id: 'B', total: 20, items: [{ sku: 's3', qty: 3 }] },
    ],
  },
};

test('主数组字段提取', () => {
  const r = extractRows(body, { arrayPath: 'data.list', fields: [{ path: 'id' }, { path: 'total', as: '金额' }] });
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.rows, [{ id: 'A', 金额: 10 }, { id: 'B', 金额: 20 }]);
});

test('嵌套展开保留父子键，行数=子数组长度之和', () => {
  const cfg = {
    arrayPath: 'data.list', fields: [{ path: 'id' }],
    nestedArrays: [{ id: 'n1', path: 'items', parentKey: 'id', childKey: 'sku', fields: [{ path: 'qty' }] }],
  };
  const r = extractRows(body, cfg);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[0], { id: 'A', '父键.id': 'A', '子键.sku': 's1', qty: 1 });
  assert.deepEqual(r.rows[2], { id: 'B', '父键.id': 'B', '子键.sku': 's3', qty: 3 });
  const counts = previewRowCounts([body], cfg);
  assert.equal(counts.baseRows, 2);
  assert.equal(counts.expandedRows, 3);
});

test('并列子数组未设关联键时拒绝执行（防交叉组合）', () => {
  const b2 = { list: [{ id: 'A', xs: [{ v: 1 }], ys: [{ w: 2 }] }] };
  const r = extractRows(b2, {
    arrayPath: 'list', fields: [{ path: 'id' }],
    nestedArrays: [
      { id: 'n1', path: 'xs', parentKey: 'id', childKey: 'v', fields: [{ path: 'v' }] },
      { id: 'n2', path: 'ys', parentKey: 'id', childKey: 'w', fields: [{ path: 'w' }] },
    ],
  });
  assert.ok(r.errors.some((e) => e.includes('并列子数组')));
  assert.equal(r.rows.length, 0);
});

test('并列子数组按键关联（LEFT JOIN），不产生交叉积', () => {
  const b2 = {
    list: [{
      id: 'A',
      xs: [{ k: 'x1', v: 1 }, { k: 'x2', v: 2 }],
      ys: [{ fk: 'x2', w: 9 }],
    }],
  };
  const r = extractRows(b2, {
    arrayPath: 'list', fields: [{ path: 'id' }],
    nestedArrays: [
      { id: 'n1', path: 'xs', parentKey: 'id', childKey: 'k', fields: [{ path: 'v' }] },
      { id: 'n2', path: 'ys', parentKey: 'id', childKey: 'fk', fields: [{ path: 'w' }], joinWith: 'n1', joinParentKey: '子键.k', joinChildKey: 'fk' },
    ],
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.rows.length, 2); // 不是 2×1 交叉之外的膨胀，也无重复组合
  assert.deepEqual(r.rows[0], { id: 'A', '父键.id': 'A', '子键.k': 'x1', v: 1, w: null });
  assert.deepEqual(r.rows[1], { id: 'A', '父键.id': 'A', '子键.k': 'x2', v: 2, w: 9 });
});

test('数组路径不存在时返回错误而非空数据', () => {
  const r = extractRows({ a: 1 }, { arrayPath: 'data.list', fields: [] });
  assert.ok(r.errors[0].includes('data.list'));
});

/* ---------- 结构指纹与差异 ---------- */
test('结构指纹差异：新增/缺失/类型变化', () => {
  const fp1 = fingerprint({ list: [{ id: 'A', total: 1, remark: 'x' }] }, 'list');
  const fp2 = fingerprint({ list: [{ id: 'A', totalAmount: 1, currency: 'CNY' }] }, 'list');
  const d = diffFingerprints(fp1, fp2);
  assert.ok(d.added.includes('totalAmount'));
  assert.ok(d.added.includes('currency'));
  assert.ok(d.removed.includes('total'));
  assert.ok(d.removed.includes('remark'));
  assert.equal(d.compatible, false);
  const d2 = diffFingerprints(fp1, fingerprint({ list: [{ id: 'B', total: 2, remark: null, extra: 1 }] }, 'list'));
  assert.ok(d2.added.includes('extra'));
  assert.ok(d2.removed.length === 0);
});

/* ---------- 参数对象 ---------- */
test('paramsObject 合并 query 与表单', () => {
  assert.deepEqual(paramsObject({ query: [{ name: 'a', value: '1' }], postParams: [{ name: 'b', value: '2' }] }), { a: '1', b: '2' });
});
