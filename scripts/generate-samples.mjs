// 生成本地样本 HAR：重复分页、错误响应、缺失响应体、base64 响应体、嵌套数组、敏感头。
// 运行：npm run samples
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');
fs.mkdirSync(dir, { recursive: true });

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const text = (obj) => JSON.stringify(obj);

const AUTH_HEADERS = [
  { name: 'Cookie', value: 'sessionid=abc123secret; csrftoken=xyz789' },
  { name: 'Authorization', value: 'Bearer sk-live-SECRET-TOKEN-12345' },
  { name: 'User-Agent', value: 'Mozilla/5.0 (sample)' },
  { name: 'Accept', value: 'application/json' },
];
const RESP_HEADERS = [
  { name: 'Content-Type', value: 'application/json; charset=utf-8' },
  { name: 'Set-Cookie', value: 'sessionid=abc123secret; HttpOnly' },
];

function order(id, page, items, extra = {}) {
  return {
    id: `ORD-${id}`,
    status: id % 3 === 0 ? 'shipped' : 'paid',
    total: id * 100 + 0.5,
    remark: id % 2 === 0 ? `备注${id}` : null,
    buyer: { name: `买家${id}`, vip: id % 2 === 0 },
    items,
    discounts: items.filter((_, i) => i === 0).map((it) => ({ itemId: it.itemId, amount: 5 })),
    page,
    ...extra,
  };
}
const item = (orderId, n) => ({ itemId: `IT-${orderId}-${n}`, sku: `SKU-${n}`, qty: n, price: 50 * n });

const page1 = { code: 0, data: { page: 1, total: 6, list: [order(1, 1, [item(1, 1), item(1, 2)]), order(2, 1, [item(2, 1)])] } };
const page2 = { code: 0, data: { page: 2, total: 6, list: [order(3, 2, [item(3, 1)]), order(4, 2, [item(4, 1), item(4, 2)])] } };
const page4 = { code: 0, data: { page: 4, total: 6, list: [order(7, 4, [item(7, 1)]), order(8, 4, [item(8, 1)])] } };
const errBody = { code: 500, message: 'internal server error' };

function entry({ url, method = 'GET', status = 200, statusText = 'OK', body, base64 = false, noBody = false, startedAt, postData }) {
  const content = { size: 0, mimeType: 'application/json' };
  if (!noBody && body !== undefined) {
    if (base64) { content.text = b64(body); content.encoding = 'base64'; content.size = content.text.length; }
    else { content.text = text(body); content.size = content.text.length; }
  } else if (noBody) {
    content.size = 1234; // 服务器返回过内容，但 HAR 未保存响应体
  }
  const u = new URL(url);
  return {
    startedDateTime: startedAt,
    time: 35,
    request: {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      headers: AUTH_HEADERS,
      queryString: [...u.searchParams.entries()].map(([name, value]) => ({ name, value })),
      cookies: [{ name: 'sessionid', value: 'abc123secret' }],
      ...(postData ? { postData } : {}),
      headersSize: -1,
      bodySize: postData?.text?.length || 0,
    },
    response: {
      status,
      statusText,
      httpVersion: 'HTTP/1.1',
      headers: RESP_HEADERS,
      cookies: [{ name: 'sessionid', value: 'abc123secret' }],
      content,
      redirectURL: '',
      headersSize: -1,
      bodySize: content.size,
    },
    cache: {},
    timings: { send: 1, wait: 30, receive: 4 },
  };
}

const har = (entries) => ({
  log: {
    version: '1.2',
    creator: { name: 'sample-generator', version: '1.0' },
    pages: [],
    entries,
  },
});

// ── 样本 A：重复分页 + 错误响应 + 缺失响应体 + base64 ─────────────
const a = har([
  entry({ url: 'https://shop.example.com/api/orders?page=1&size=2', body: page1, startedAt: '2026-11-10T09:00:01.000Z' }),
  entry({ url: 'https://shop.example.com/api/orders?page=2&size=2', body: page2, base64: true, startedAt: '2026-11-10T09:00:02.000Z' }),
  // 网络重试：与上一条响应完全相同，应被去重
  entry({ url: 'https://shop.example.com/api/orders?page=2&size=2', body: page2, base64: true, startedAt: '2026-11-10T09:00:03.500Z' }),
  // 服务器错误，应列入失败
  entry({ url: 'https://shop.example.com/api/orders?page=3&size=2', status: 500, statusText: 'Internal Server Error', body: errBody, startedAt: '2026-11-10T09:00:05.000Z' }),
  // HAR 未保存响应体，应明确标记缺失
  entry({ url: 'https://shop.example.com/api/orders?page=4&size=2', noBody: true, startedAt: '2026-11-10T09:00:06.000Z' }),
  // 重试成功拿到第 4 页
  entry({ url: 'https://shop.example.com/api/orders?page=4&size=2', body: page4, startedAt: '2026-11-10T09:00:08.000Z' }),
  // 含敏感字段的 JSON 响应（token 应被清除）
  entry({
    url: 'https://shop.example.com/api/profile',
    body: { id: 42, name: '演示用户', token: 'SECRET-PROFILE-TOKEN', wallet: { balance: 88.5, accessToken: 'SECRET-WALLET-TOKEN' } },
    startedAt: '2026-11-10T09:01:00.000Z',
  }),
  // 带敏感查询参数与表单参数的请求
  entry({
    url: 'https://shop.example.com/api/orders/search?keyword=裙&access_token=SECRET-QS-TOKEN',
    method: 'POST',
    body: { code: 0, data: { list: [order(9, 1, [item(9, 1)])] } },
    postData: {
      mimeType: 'application/x-www-form-urlencoded',
      params: [
        { name: 'keyword', value: '裙' },
        { name: 'token', value: 'SECRET-FORM-TOKEN' },
      ],
      text: 'keyword=%E8%A3%99&token=SECRET-FORM-TOKEN',
    },
    startedAt: '2026-11-10T09:02:00.000Z',
  }),
]);

// ── 样本 B：结构漂移（字段改名/新增/缺失），用于方案差异检查 ──────
const orderB = (id, page, items) => ({
  id: `ORD-${id}`,
  status: 'paid',
  totalAmount: id * 100 + 0.5, // 原 total 改名
  currency: 'CNY',             // 新增字段
  // remark 字段被移除
  buyer: { name: `买家${id}`, vip: false },
  items,
  discounts: [],
  page,
});
const b = har([
  entry({ url: 'https://shop.example.com/api/orders?page=1&size=2', body: { code: 0, data: { page: 1, total: 4, list: [orderB(1, 1, [item(1, 1)]), orderB(2, 1, [item(2, 1)])] } }, startedAt: '2026-11-12T10:00:01.000Z' }),
  entry({ url: 'https://shop.example.com/api/orders?page=2&size=2', body: { code: 0, data: { page: 2, total: 4, list: [orderB(3, 2, [item(3, 1)]), orderB(4, 2, [item(4, 1)])] } }, startedAt: '2026-11-12T10:00:02.000Z' }),
]);

fs.writeFileSync(path.join(dir, 'shop-orders-a.har'), JSON.stringify(a, null, 2));
fs.writeFileSync(path.join(dir, 'shop-orders-b.har'), JSON.stringify(b, null, 2));
fs.writeFileSync(path.join(dir, 'samples.json'), JSON.stringify({
  'shop-orders-a.har': '订单分页：含 base64 响应体、重试重复（第2页）、500 错误（第3页）、响应体缺失（第4页首次）、敏感头与敏感参数',
  'shop-orders-b.har': '同接口另一次导出：字段改名 total→totalAmount、新增 currency、移除 remark，用于方案结构差异检查',
}, null, 2));
console.log('样本已生成到 samples/');
