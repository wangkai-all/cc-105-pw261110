/* HAR 数据提取工具前端。所有数据均来自本地后端已脱敏的存储。 */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, opts.body !== undefined
    ? { method: opts.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) }
    : { method: opts.method || 'GET' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, ms = 2600) {
  const d = document.createElement('div');
  d.textContent = msg;
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), ms);
}

const fmtTime = (s) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-');
const statusCls = (s) => `status s${String(s)[0] || '0'}`;
const bodyStateChip = (e) => {
  if (e.failed) return '<span class="chip err">失败</span>';
  if (e.body_state === 'missing') return '<span class="chip warn">响应体缺失</span>';
  if (e.body_state === 'not_json') return '<span class="chip">非JSON</span>';
  if (e.body_state === 'ok') return '<span class="chip ok">JSON</span>';
  return '<span class="chip">空</span>';
};

/* ---------------- 路由 ---------------- */
const routes = {
  imports: renderImports,
  requests: renderRequests,
  extract: renderExtract,
  schemes: renderSchemes,
  datasets: renderDatasets,
};

function parseHash() {
  const h = location.hash.slice(2) || 'imports';
  const [path, qs] = h.split('?');
  return { path: path || 'imports', q: new URLSearchParams(qs || '') };
}

async function route() {
  const { path, q } = parseHash();
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === path));
  const fn = routes[path] || renderImports;
  app.innerHTML = '<p class="muted">加载中…</p>';
  try { await fn(q); } catch (e) { app.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

/* ---------------- 导入页 ---------------- */
async function renderImports() {
  const [imports, samples] = await Promise.all([api('/api/imports'), api('/api/samples')]);
  app.innerHTML = `
    <h2>导入 HAR</h2>
    <div class="grid cols">
      <div class="panel">
        <h3>上传文件</h3>
        <input type="file" id="harFile" accept=".har,.json">
        <h3>敏感字段配置（导入时清除，永不入库）</h3>
        <p class="muted">请求/响应头（每行一个）</p>
        <textarea id="cfgHeaders"></textarea>
        <p class="muted">查询/表单参数名</p>
        <textarea id="cfgParams"></textarea>
        <p class="muted">JSON 响应体中的键名</p>
        <textarea id="cfgJsonKeys"></textarea>
        <div class="row" style="margin-top:10px">
          <button class="primary" id="btnUpload">脱敏并导入</button>
          <button id="btnResetCfg">恢复默认</button>
        </div>
        <h3>本地样本</h3>
        ${samples.map((s) => `
          <div class="panel" style="padding:10px;margin-bottom:8px">
            <div class="row" style="justify-content:space-between">
              <b class="mono">${esc(s.file)}</b>
              <button class="small" data-sample="${esc(s.file)}">导入样本</button>
            </div>
            <div class="muted" style="margin-top:4px">${esc(s.description)}</div>
          </div>`).join('') || '<p class="muted">samples/ 目录为空，运行 npm run samples 生成。</p>'}
      </div>
      <div class="panel">
        <h3>已导入（仅存脱敏数据）</h3>
        <table>
          <thead><tr><th>ID</th><th>名称</th><th>来源</th><th>请求数</th><th>导入时间</th><th>提示</th><th></th></tr></thead>
          <tbody>
            ${imports.map((i) => `
              <tr>
                <td>${i.id}</td>
                <td><a href="#/requests?import=${i.id}">${esc(i.name)}</a></td>
                <td>${esc(i.source)}</td>
                <td>${i.entry_count}</td>
                <td>${fmtTime(i.created_at)}</td>
                <td>${i.warnings.length ? `<span class="chip warn" title="${esc(i.warnings.join('\n'))}">${i.warnings.length} 条提示</span>` : '<span class="chip ok">正常</span>'}</td>
                <td><button class="small danger" data-del-import="${i.id}">删除</button></td>
              </tr>`).join('') || '<tr><td colspan="7" class="muted">还没有导入记录</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  const defaults = await api('/api/health').then(() => DEFAULT_CFG);
  fillCfg(defaults);

  $('#btnResetCfg').onclick = () => fillCfg(DEFAULT_CFG);
  $('#btnUpload').onclick = uploadHar;
  app.querySelectorAll('[data-sample]').forEach((b) => (b.onclick = async () => {
    const r = await api('/api/imports/sample', { body: { file: b.dataset.sample } });
    toast(`样本已导入：${r.entryCount} 条请求${r.warnings.length ? `，${r.warnings.length} 条提示` : ''}`);
    route();
  }));
  app.querySelectorAll('[data-del-import]').forEach((b) => (b.onclick = async () => {
    if (!confirm('删除该导入及其全部请求记录？')) return;
    await api(`/api/imports/${b.dataset.delImport}`, { method: 'DELETE' });
    route();
  }));
}

const DEFAULT_CFG = {
  headers: ['cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token', 'x-session-token'],
  params: ['token', 'access_token', 'refresh_token', 'id_token', 'sessionid', 'session_id', 'api_key', 'apikey', 'auth', 'signature', 'sig', 'secret', 'password', 'passwd'],
  jsonKeys: ['token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'sessionId', 'sessionid', 'secret', 'password', 'authorization', 'cookie'],
};

function fillCfg(cfg) {
  $('#cfgHeaders').value = cfg.headers.join('\n');
  $('#cfgParams').value = cfg.params.join('\n');
  $('#cfgJsonKeys').value = cfg.jsonKeys.join('\n');
}

async function uploadHar() {
  const f = $('#harFile').files[0];
  if (!f) return toast('请先选择 HAR 文件');
  const harText = await f.text();
  const lines = (id) => $(id).value.split('\n').map((s) => s.trim()).filter(Boolean);
  try {
    const r = await api('/api/imports', {
      body: {
        name: f.name,
        harText,
        sanitizeConfig: { headers: lines('#cfgHeaders'), params: lines('#cfgParams'), jsonKeys: lines('#cfgJsonKeys') },
      },
    });
    toast(`已导入 ${r.entryCount} 条请求${r.warnings.length ? `，${r.warnings.length} 条提示` : ''}`);
    location.hash = `#/requests?import=${r.id}`;
  } catch (e) { toast(e.message, 4000); }
}

/* ---------------- 请求浏览页 ---------------- */
async function renderRequests(q) {
  const imports = await api('/api/imports');
  if (!imports.length) { app.innerHTML = '<div class="notice info">请先在「导入」页上传 HAR 或导入样本。</div>'; return; }
  const importId = Number(q.get('import')) || imports[0].id;
  const data = await api(`/api/imports/${importId}/endpoints`);
  const state = { importId, endpoint: q.get('endpoint') || data.endpoints[0]?.endpoint || '', status: '', state: '', q: '' };

  app.innerHTML = `
    <h2>请求浏览</h2>
    <div class="row" style="margin-bottom:12px">
      <label>导入记录 <select id="selImport">${imports.map((i) => `<option value="${i.id}" ${i.id === importId ? 'selected' : ''}>#${i.id} ${esc(i.name)}</option>`).join('')}</select></label>
    </div>
    <div class="grid cols">
      <div class="panel" id="endpointPanel"></div>
      <div class="panel">
        <div class="row" style="margin-bottom:10px">
          <input id="fQ" placeholder="URL 包含…" style="width:180px">
          <select id="fStatus"><option value="">全部状态码</option><option>200</option><option>204</option><option>301</option><option>400</option><option>401</option><option>403</option><option>404</option><option>500</option><option>502</option></select>
          <select id="fState"><option value="">全部</option><option value="ok">可用 JSON</option><option value="failed">失败</option><option value="missing">响应体缺失</option></select>
          <button id="btnFilter">筛选</button>
          <span style="flex:1"></span>
          <button class="primary" id="btnExtract">去提取该接口 →</button>
        </div>
        <div id="seriesInfo"></div>
        <div class="scroll-x"><table id="entriesTable">
          <thead><tr><th>时间</th><th>方法</th><th>URL</th><th>状态</th><th>响应</th><th>分页参数</th><th>标记</th></tr></thead>
          <tbody></tbody>
        </table></div>
      </div>
    </div>
    <div id="drawerHost"></div>`;

  $('#selImport').onchange = (e) => { location.hash = `#/requests?import=${e.target.value}`; };
  $('#btnExtract').onclick = () => { if (state.endpoint) location.hash = `#/extract?import=${state.importId}&endpoint=${encodeURIComponent(state.endpoint)}`; };
  $('#btnFilter').onclick = () => { state.q = $('#fQ').value; state.status = $('#fStatus').value; state.state = $('#fState').value; loadEntries(); };

  const panel = $('#endpointPanel');
  panel.innerHTML = '<h3>接口（按路径分组）</h3>' + data.endpoints.map((ep) => {
    const series = data.seriesByEndpoint[ep.endpoint] || [];
    const dup = series.reduce((n, s) => n + s.duplicates, 0);
    return `<div class="endpoint-item ${ep.endpoint === state.endpoint ? 'active' : ''}" data-ep="${esc(ep.endpoint)}">
      <div class="mono">${esc(ep.endpoint)}</div>
      <div>
        <span class="chip">${ep.count} 条</span>
        ${ep.failed ? `<span class="chip err">失败 ${ep.failed}</span>` : ''}
        ${ep.missing ? `<span class="chip warn">缺失 ${ep.missing}</span>` : ''}
        ${dup ? `<span class="chip info">重复 ${dup}</span>` : ''}
        ${series.length && series[0].pageParamNames.length ? `<span class="chip">分页参数: ${esc(series[0].pageParamNames.join(', '))}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  panel.querySelectorAll('[data-ep]').forEach((el) => (el.onclick = () => {
    state.endpoint = el.dataset.ep;
    panel.querySelectorAll('.endpoint-item').forEach((x) => x.classList.toggle('active', x === el));
    loadEntries();
  }));

  async function loadEntries() {
    const p = new URLSearchParams({ endpoint: state.endpoint });
    if (state.status) p.set('status', state.status);
    if (state.state) p.set('state', state.state);
    if (state.q) p.set('q', state.q);
    const entries = await api(`/api/imports/${state.importId}/entries?${p}`);
    const tb = $('#entriesTable tbody');
    tb.innerHTML = entries.map((e) => `
      <tr class="clickable" data-id="${e.id}">
        <td class="mono">${fmtTime(e.started_at)}</td>
        <td>${esc(e.method)}</td>
        <td class="mono" style="max-width:340px;word-break:break-all">${esc(e.url)}</td>
        <td class="${statusCls(e.status)}">${e.status || '失败'}</td>
        <td>${bodyStateChip(e)}</td>
        <td>${Object.entries(e.pageParams || {}).map(([k, v]) => `<span class="chip info">${esc(k)}=${esc(v)}</span>`).join('')}</td>
        <td>${e.duplicateOf ? `<span class="chip warn">重复(重试)</span>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">无匹配请求</td></tr>';
    tb.querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = () => showEntry(tr.dataset.id)));
    $('#seriesInfo').innerHTML = `<span class="muted">共 ${entries.length} 条；相同响应的重试已标注，提取时自动去重，失败与缺失单列。</span>`;
  }

  async function showEntry(id) {
    const e = await api(`/api/entries/${id}`);
    const host = $('#drawerHost');
    host.innerHTML = `<div class="drawer">
      <button class="close" id="closeDrawer">关闭 ✕</button>
      <h3>请求详情 #${e.id}</h3>
      <dl class="kv">
        <dt>时间</dt><dd>${fmtTime(e.started_at)}（${e.time_ms} ms）</dd>
        <dt>方法</dt><dd>${esc(e.method)}</dd>
        <dt>URL</dt><dd class="mono">${esc(e.url)}</dd>
        <dt>状态</dt><dd class="${statusCls(e.status)}">${e.status} ${esc(e.status_text || '')}</dd>
        <dt>类型</dt><dd>${esc(e.mime_type || '-')}</dd>
      </dl>
      <h3>请求参数（已脱敏）</h3>
      ${e.query.length || e.postParams.length ? `<table><tbody>
        ${e.query.map((p) => `<tr><td class="mono">${esc(p.name)}</td><td class="mono">${esc(p.value)}</td><td class="muted">query</td></tr>`).join('')}
        ${e.postParams.map((p) => `<tr><td class="mono">${esc(p.name)}</td><td class="mono">${esc(p.value)}</td><td class="muted">form</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">无</p>'}
      ${e.post_text ? `<h3>请求体（已脱敏）</h3><pre class="mono" style="white-space:pre-wrap">${esc(e.post_text)}</pre>` : ''}
      ${e.post_text_state === 'missing' ? '<div class="notice warn">请求体未保存在 HAR 中</div>' : ''}
      <h3>响应头（已脱敏）</h3>
      <table><tbody>${e.responseHeaders.map((hh) => `<tr><td class="mono">${esc(hh.name)}</td><td class="mono">${esc(hh.value)}</td></tr>`).join('') || '<tr><td class="muted">无</td></tr>'}</tbody></table>
      <h3>响应体</h3>
      ${e.body_state === 'missing'
        ? '<div class="notice err">⚠ HAR 文件未保存该响应的响应体，无法提供数据。系统不会补造内容。</div>'
        : e.body_state === 'ok'
          ? `<div class="jtree">${jsonTree(e.body)}</div>`
          : `<pre class="mono" style="white-space:pre-wrap">${esc(e.body_text || '(空)')}</pre>`}
    </div>`;
    $('#closeDrawer').onclick = () => (host.innerHTML = '');
  }

  await loadEntries();
}

/* 只读 JSON 树 */
function jsonTree(node, key = null, path = '', depth = 0) {
  const keyHtml = key !== null ? `<span class="key">${esc(key)}</span>: ` : '';
  if (node === null) return `<div class="line node">${keyHtml}<span class="null">null</span></div>`;
  if (Array.isArray(node)) {
    const kids = node.slice(0, 5).map((v, i) => jsonTree(v, `[${i}]`, `${path}[${i}]`, depth + 1)).join('');
    return `<div class="line node">${keyHtml}<span class="arr">Array(${node.length})</span>${depth < 6 ? kids : ''}${node.length > 5 ? `<div class="node muted">… 共 ${node.length} 项</div>` : ''}</div>`;
  }
  if (typeof node === 'object') {
    const kids = Object.entries(node).map(([k, v]) => jsonTree(v, k, path ? `${path}.${k}` : k, depth + 1)).join('');
    return `<div class="line node">${keyHtml}{}${depth < 6 ? kids : ''}</div>`;
  }
  const cls = typeof node === 'string' ? 'str' : typeof node === 'number' ? 'num' : 'bool';
  return `<div class="line node">${keyHtml}<span class="${cls}">${esc(JSON.stringify(node))}</span></div>`;
}

/* ---------------- 提取配置页 ---------------- */
const extractState = {
  importId: 0, endpoint: '', entry: null, schemeId: null,
  config: { endpoint: '', arrayPath: null, fields: [], paramColumns: [], nestedArrays: [] },
};

async function renderExtract(q) {
  const imports = await api('/api/imports');
  if (!imports.length) { app.innerHTML = '<div class="notice info">请先导入 HAR。</div>'; return; }
  extractState.importId = Number(q.get('import')) || imports[0].id;
  const schemeId = q.get('scheme');
  let schemeCfg = null;
  if (schemeId) {
    const s = await api(`/api/schemes/${schemeId}`);
    schemeCfg = s.config;
    extractState.schemeId = s.id;
  } else extractState.schemeId = null;

  const epData = await api(`/api/imports/${extractState.importId}/endpoints`);
  extractState.endpoint = q.get('endpoint') || schemeCfg?.endpoint || epData.endpoints[0]?.endpoint || '';
  extractState.config = schemeCfg
    ? JSON.parse(JSON.stringify(schemeCfg))
    : { endpoint: extractState.endpoint, arrayPath: null, fields: [], paramColumns: [], nestedArrays: [] };
  extractState.config.endpoint = extractState.endpoint;

  app.innerHTML = `
    <h2>配置提取</h2>
    <div class="panel row">
      <label>导入记录 <select id="selImport">${imports.map((i) => `<option value="${i.id}" ${i.id === extractState.importId ? 'selected' : ''}>#${i.id} ${esc(i.name)}</option>`).join('')}</select></label>
      <label>接口 <select id="selEndpoint">${epData.endpoints.map((e) => `<option ${e.endpoint === extractState.endpoint ? 'selected' : ''}>${esc(e.endpoint)}</option>`).join('')}</select></label>
      <span class="muted">在下方 JSON 树中点选数组路径与字段</span>
    </div>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="panel"><h3>① 响应结构（样本请求）</h3><div id="treeHost" class="jtree"></div></div>
      <div>
        <div class="panel"><h3>② 输出配置</h3><div id="cfgHost"></div></div>
        <div class="panel"><h3>③ 预览与执行</h3><div id="previewHost"><p class="muted">配置数组路径后点击「预览」。</p></div></div>
      </div>
    </div>`;

  $('#selImport').onchange = (e) => { location.hash = `#/extract?import=${e.target.value}`; };
  $('#selEndpoint').onchange = (e) => { location.hash = `#/extract?import=${extractState.importId}&endpoint=${encodeURIComponent(e.target.value)}`; };

  await loadSampleEntry();
  renderTree();
  renderCfg();
}

async function loadSampleEntry() {
  const entries = await api(`/api/imports/${extractState.importId}/entries?endpoint=${encodeURIComponent(extractState.endpoint)}&state=ok`);
  extractState.entry = entries.length ? await api(`/api/entries/${entries[0].id}`) : null;
}

/* 可点选 JSON 树：数组节点可设为数组路径；数组项内标量可加为字段；嵌套数组可展开为子表 */
function renderTree() {
  const host = $('#treeHost');
  const e = extractState.entry;
  if (!e) { host.innerHTML = '<div class="notice warn">该接口没有可用的 JSON 响应（可能全部失败或响应体缺失）。</div>'; return; }
  const ap = extractState.config.arrayPath;
  host.innerHTML = treeNode(e.body, null, '', 0);
  host.querySelectorAll('[data-act]').forEach((el) => (el.onclick = (ev) => {
    ev.stopPropagation();
    const path = el.dataset.path;
    if (el.dataset.act === 'setArray') {
      extractState.config.arrayPath = path;
      extractState.config.fields = [];
      extractState.config.nestedArrays = [];
    } else if (el.dataset.act === 'addField') {
      const rel = relPath(path, ap);
      if (rel && !extractState.config.fields.some((f) => f.path === rel)) {
        extractState.config.fields.push({ path: rel, as: rel });
      }
    } else if (el.dataset.act === 'addNested') {
      const rel = relPath(path, ap);
      if (rel && !extractState.config.nestedArrays.some((n) => n.path === rel)) {
        extractState.config.nestedArrays.push({
          id: 'n' + Date.now(), path: rel, parentKey: '', childKey: '', fields: [],
          joinWith: '', joinParentKey: '', joinChildKey: '',
        });
      }
    }
    renderTree();
    renderCfg();
  }));
}

function relPath(absPath, arrayPath) {
  const prefix = `${arrayPath}[]`;
  if (arrayPath == null || !absPath.startsWith(prefix)) return null;
  return absPath.slice(prefix.length).replace(/^\./, '');
}

function treeNode(node, key, path, depth) {
  const ap = extractState.config.arrayPath;
  const keyHtml = key !== null ? `<span class="key">${esc(key)}</span>: ` : '';
  const inItem = ap != null && path.startsWith(`${ap}[]`);
  if (Array.isArray(node)) {
    const isAp = path === ap;
    const acts = [`<button class="small" data-act="setArray" data-path="${esc(path)}">${isAp ? '✓ 当前数组路径' : '设为数组路径'}</button>`];
    if (inItem && path !== `${ap}[]`) acts.push(`<button class="small" data-act="addNested" data-path="${esc(path)}">展开为子表</button>`);
    const sample = node[0];
    const kids = sample !== undefined && depth < 8 ? treeNode(sample, '[]', `${path}[]`, depth + 1) : '';
    return `<div class="line node ${isAp ? 'selected' : ''}">${keyHtml}<span class="arr">Array(${node.length})</span><span class="acts">${acts.join('')}</span>${kids}</div>`;
  }
  if (node && typeof node === 'object') {
    const kids = depth < 8 ? Object.entries(node).map(([k, v]) => treeNode(v, k, path ? `${path}.${k}` : k, depth + 1)).join('') : '';
    return `<div class="line node">${keyHtml}{}${kids}</div>`;
  }
  const cls = typeof node === 'string' ? 'str' : typeof node === 'number' ? 'num' : node === null ? 'null' : 'bool';
  const acts = inItem ? `<button class="small" data-act="addField" data-path="${esc(path)}">添加字段</button>` : '';
  return `<div class="line node">${keyHtml}<span class="${cls}">${esc(JSON.stringify(node))}</span><span class="acts">${acts}</span></div>`;
}

/* 输出配置区：字段、参数列、子表（含父子键与并列数组关联键） */
function renderCfg() {
  const cfg = extractState.config;
  const host = $('#cfgHost');
  if (cfg.arrayPath == null) { host.innerHTML = '<p class="muted">请先在左侧点选一个数组作为提取路径。</p>'; return; }

  const item = sampleItem();
  const parentScalars = item ? scalarPaths(item) : [];
  const entry = extractState.entry;
  const params = entry ? [...entry.query, ...entry.postParams].map((p) => p.name) : [];

  host.innerHTML = `
    <dl class="kv"><dt>数组路径</dt><dd class="mono">${esc(cfg.arrayPath)}</dd></dl>
    <h3>输出字段（点击移除）</h3>
    <div class="field-list">${cfg.fields.map((f, i) => `<span class="chip" data-rm-field="${i}" title="点击移除">${esc(f.as)} <small class="muted">${esc(f.path)}</small> ✕</span>`).join('') || '<span class="muted">尚未选择字段</span>'}</div>
    <h3>请求参数列</h3>
    <div class="row">${[...new Set(params)].map((p) => `
      <label class="chip"><input type="checkbox" data-param="${esc(p)}" ${cfg.paramColumns.some((c) => c.param === p) ? 'checked' : ''}> ${esc(p)}</label>`).join('') || '<span class="muted">该请求无参数</span>'}</div>
    <h3>嵌套子表（展开前请确认行数预览）</h3>
    ${cfg.nestedArrays.map((n, i) => nestedCard(n, i, parentScalars)).join('') || '<p class="muted">无。若数组项内还有数组，可在左侧点「展开为子表」。</p>'}
    <div class="row" style="margin-top:14px">
      <button class="primary" id="btnPreview">预 览</button>
      <input id="schemeName" placeholder="方案名称" style="width:160px">
      <button id="btnSaveScheme">保存为方案</button>
      <button class="primary" id="btnRun">批量执行 → 数据集</button>
    </div>`;

  host.querySelectorAll('[data-rm-field]').forEach((el) => (el.onclick = () => {
    cfg.fields.splice(Number(el.dataset.rmField), 1);
    renderCfg();
  }));
  host.querySelectorAll('[data-param]').forEach((el) => (el.onchange = () => {
    cfg.paramColumns = [...host.querySelectorAll('[data-param]:checked')].map((c) => ({ param: c.dataset.param, as: `参数.${c.dataset.param}` }));
  }));
  host.querySelectorAll('[data-nested]').forEach((el) => (el.onchange = () => {
    const n = cfg.nestedArrays[Number(el.dataset.nested)];
    n[el.dataset.key] = el.value;
    if (el.dataset.key === 'childKey' && el.value) n.childKeyAs = `子键.${el.value}`;
    if (el.dataset.key === 'parentKey' && el.value) n.parentKeyAs = `父键.${el.value}`;
    // 并列子数组：自动把 joinParentKey 指向被关联数组的子键输出列
    const siblings = cfg.nestedArrays.filter((x) => x !== n && parentOf(x.path) === parentOf(n.path));
    if (n.joinWith) {
      const target = cfg.nestedArrays.find((x) => x.id === n.joinWith);
      if (target?.childKey) n.joinParentKey = target.childKeyAs || `子键.${target.childKey}`;
    }
    renderCfg();
  }));
  host.querySelectorAll('[data-nested-field]').forEach((el) => (el.onchange = () => {
    const n = cfg.nestedArrays[Number(el.dataset.nestedField)];
    if (el.value && !n.fields.some((f) => f.path === el.value)) n.fields.push({ path: el.value, as: el.value });
    renderCfg();
  }));
  host.querySelectorAll('[data-rm-nested]').forEach((el) => (el.onclick = () => {
    cfg.nestedArrays.splice(Number(el.dataset.rmNested), 1);
    renderCfg();
  }));
  host.querySelectorAll('[data-rm-nf]').forEach((el) => (el.onclick = () => {
    const [ni, fi] = el.dataset.rmNf.split(':').map(Number);
    cfg.nestedArrays[ni].fields.splice(fi, 1);
    renderCfg();
  }));

  $('#btnPreview').onclick = doPreview;
  $('#btnRun').onclick = doRun;
  $('#btnSaveScheme').onclick = doSaveScheme;
}

function parentOf(p) { const i = p.lastIndexOf('.'); return i === -1 ? '' : p.slice(0, i); }

function sampleItem() {
  const e = extractState.entry;
  if (!e || extractState.config.arrayPath == null) return null;
  const segs = extractState.config.arrayPath.split('.').filter(Boolean);
  let cur = e.body;
  for (const s of segs) cur = cur?.[s];
  return Array.isArray(cur) ? cur[0] : null;
}

function scalarPaths(node, prefix = '', out = [], depth = 0) {
  if (depth > 5 || node == null || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v === null || typeof v !== 'object') out.push(p);
    else if (!Array.isArray(v)) scalarPaths(v, p, out, depth + 1);
  }
  return out;
}

function nestedItemOf(relPath) {
  const item = sampleItem();
  if (!item) return null;
  let cur = item;
  for (const s of relPath.split('.')) cur = cur?.[s];
  return Array.isArray(cur) ? cur[0] : null;
}

function nestedCard(n, i, parentScalars) {
  const cfg = extractState.config;
  const childScalars = scalarPaths(nestedItemOf(n.path) || {});
  const siblings = cfg.nestedArrays.filter((x, xi) => xi !== i && parentOf(x.path) === parentOf(n.path));
  const needJoin = siblings.length > 0;
  const opts = (list, sel) => `<option value="">（未选择）</option>` + list.map((s) => `<option ${s === sel ? 'selected' : ''}>${esc(s)}</option>`).join('');
  return `<div class="panel" style="background:#fafbfc">
    <div class="row" style="justify-content:space-between">
      <b class="mono">子表：${esc(n.path)}</b>
      <button class="small danger" data-rm-nested="${i}">移除</button>
    </div>
    <div class="row" style="margin-top:6px">
      <label>父键 <select data-nested="${i}" data-key="parentKey">${opts(parentScalars, n.parentKey)}</select></label>
      <label>子键 <select data-nested="${i}" data-key="childKey">${opts(childScalars, n.childKey)}</select></label>
      <label>添加子表字段 <select data-nested-field="${i}"><option value="">选择字段…</option>${childScalars.map((s) => `<option>${esc(s)}</option>`).join('')}</select></label>
    </div>
    <div class="field-list" style="margin-top:6px">${n.fields.map((f, fi) => `<span class="chip" data-rm-nf="${i}:${fi}">${esc(f.as)} ✕</span>`).join('')}</div>
    ${needJoin ? `<div class="notice warn" style="margin-top:8px">检测到并列子数组（${siblings.map((s) => esc(s.path)).join('、')}）。为避免交叉组合，必须设置关联键：
      <div class="row" style="margin-top:6px">
        <label>关联到 <select data-nested="${i}" data-key="joinWith"><option value="">（不关联=禁止执行）</option>${siblings.map((s) => `<option value="${s.id}" ${s.id === n.joinWith ? 'selected' : ''}>${esc(s.path)}</option>`).join('')}</select></label>
        <label>本方关联键 <select data-nested="${i}" data-key="joinChildKey">${opts(childScalars, n.joinChildKey)}</select></label>
        ${n.joinParentKey ? `<span class="chip info">匹配列：${esc(n.joinParentKey)}</span>` : ''}
      </div></div>` : ''}
  </div>`;
}

async function doPreview() {
  const host = $('#previewHost');
  host.innerHTML = '<p class="muted">预览计算中…</p>';
  try {
    const r = await api('/api/preview', { body: { importId: extractState.importId, config: extractState.config } });
    const delta = r.rowDelta > 0 ? `<span class="chip warn">展开增加 ${r.rowDelta} 行</span>` : '<span class="chip ok">无膨胀</span>';
    host.innerHTML = `
      <div class="row">
        <span class="chip info">目标请求 ${r.targetCount}</span>
        <span class="chip">基础行数 ${r.baseRows}</span>
        <span class="chip info">展开后 ${r.expandedRows}</span>
        ${delta}
        ${r.skipped.length ? `<span class="chip warn">跳过 ${r.skipped.length} 条</span>` : ''}
      </div>
      ${r.errors.map((e) => `<div class="notice err">${esc(e)}</div>`).join('')}
      ${r.warnings.map((w) => `<div class="notice warn">${esc(w)}</div>`).join('')}
      ${r.skipped.length ? `<h3>跳过/失败明细</h3><table><tbody>${r.skipped.map((s) => `<tr><td>#${s.entryId}</td><td><span class="chip ${s.reason === 'failed' ? 'err' : 'warn'}">${esc(reasonText(s.reason))}</span></td><td class="muted">${esc(s.detail)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${r.sampleRows.length ? `<h3>样例行（前 ${r.sampleRows.length} 条）</h3><div class="scroll-x"><table><thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${r.sampleRows.map((row) => `<tr>${r.columns.map((c) => `<td class="mono">${esc(row[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="muted">没有产出数据行。</p>'}`;
  } catch (e) { host.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
}

function reasonText(r) {
  return { failed: '失败响应', duplicate: '重复(重试)', missing: '响应体缺失', not_json: '非JSON', extract_error: '提取错误' }[r] || r;
}

async function doRun() {
  try {
    const r = await api('/api/extract', { body: { importId: extractState.importId, config: extractState.config, schemeId: extractState.schemeId } });
    toast(`已生成数据集 #${r.datasetId}：${r.stats.rows} 行`);
    location.hash = `#/datasets?open=${r.datasetId}`;
  } catch (e) { toast(e.message, 4000); }
}

async function doSaveScheme() {
  const name = $('#schemeName').value.trim();
  if (!name) return toast('请填写方案名称');
  try {
    const r = await api('/api/schemes', { body: { id: extractState.schemeId, name, config: extractState.config, importId: extractState.importId } });
    extractState.schemeId = r.id;
    toast(`方案已保存（#${r.id}），已记录结构指纹`);
  } catch (e) { toast(e.message, 4000); }
}

/* ---------------- 方案页 ---------------- */
async function renderSchemes() {
  const [schemes, imports] = await Promise.all([api('/api/schemes'), api('/api/imports')]);
  app.innerHTML = `
    <h2>提取方案</h2>
    ${schemes.map((s) => `
      <div class="panel">
        <div class="row" style="justify-content:space-between">
          <b>#${s.id} ${esc(s.name)}</b>
          <span class="muted">更新于 ${fmtTime(s.updated_at)}</span>
        </div>
        <dl class="kv" style="margin-top:8px">
          <dt>接口</dt><dd class="mono">${esc(s.config.endpoint)}</dd>
          <dt>数组路径</dt><dd class="mono">${esc(s.config.arrayPath)}</dd>
          <dt>字段</dt><dd>${s.config.fields.map((f) => `<span class="chip">${esc(f.as)}</span>`).join('')}</dd>
          <dt>子表</dt><dd>${(s.config.nestedArrays || []).map((n) => `<span class="chip info">${esc(n.path)}</span>`).join('') || '<span class="muted">无</span>'}</dd>
          <dt>结构指纹</dt><dd>${s.fingerprint ? `<span class="chip ok">已记录（${Object.keys(s.fingerprint.fields).length} 个字段）</span>` : '<span class="chip warn">未记录</span>'}</dd>
        </dl>
        <div class="row" style="margin-top:10px">
          <label>应用到 <select data-check-import="${s.id}">${imports.map((i) => `<option value="${i.id}">#${i.id} ${esc(i.name)}</option>`).join('')}</select></label>
          <button class="primary" data-check="${s.id}">检查结构差异</button>
          <button data-adjust="${s.id}">在提取页调整</button>
          <button class="danger" data-del-scheme="${s.id}">删除</button>
        </div>
        <div data-check-result="${s.id}"></div>
      </div>`).join('') || '<div class="notice info">还没有方案。请在「提取」页配置后保存。</div>'}`;

  app.querySelectorAll('[data-del-scheme]').forEach((b) => (b.onclick = async () => {
    if (!confirm('删除该方案？')) return;
    await api(`/api/schemes/${b.dataset.delScheme}`, { method: 'DELETE' });
    route();
  }));
  app.querySelectorAll('[data-adjust]').forEach((b) => (b.onclick = () => {
    const importId = $(`[data-check-import="${b.dataset.adjust}"]`).value;
    location.hash = `#/extract?scheme=${b.dataset.adjust}&import=${importId}`;
  }));
  app.querySelectorAll('[data-check]').forEach((b) => (b.onclick = async () => {
    const sid = b.dataset.check;
    const importId = Number($(`[data-check-import="${sid}"]`).value);
    const host = $(`[data-check-result="${sid}"]`);
    host.innerHTML = '<p class="muted">检查中…</p>';
    try {
      const r = await api(`/api/schemes/${sid}/check`, { body: { importId } });
      if (!r.ok && !r.diff) {
        host.innerHTML = `<div class="notice err">${esc(r.reason)}</div>`;
        return;
      }
      const d = r.diff;
      host.innerHTML = d ? `
        <div class="notice ${d.compatible ? 'ok' : 'warn'}">
          对比 ${r.sampleCount} 条可用响应：
          ${d.compatible ? '结构兼容，可直接执行。' : '发现结构差异，请确认后再执行。'}
        </div>
        ${d.added.length ? `<p><span class="diff-add">＋ 新增字段：</span>${d.added.map((f) => `<span class="chip ok">${esc(f)}</span>`).join('')}</p>` : ''}
        ${d.removed.length ? `<p><span class="diff-del">－ 缺失字段：</span>${d.removed.map((f) => `<span class="chip err">${esc(f)}</span>`).join('')}</p>` : ''}
        ${d.typeChanged.length ? `<p><span class="diff-chg">～ 类型变化：</span>${d.typeChanged.map((t) => `<span class="chip warn">${esc(t.path)}: ${esc(t.from.join('|'))} → ${esc(t.to.join('|'))}</span>`).join('')}</p>` : ''}
        ${r.missingFields?.length ? `<div class="notice err">方案引用的字段在新结构中缺失：${r.missingFields.map(esc).join('、')}，执行将产生空列。</div>` : ''}
        <div class="row">
          <button class="primary" data-exec-scheme="${sid}" data-import="${importId}">${d.compatible ? '执行提取' : '仍要执行'}</button>
          <button data-adjust="${sid}">先调整方案</button>
        </div>` : `<div class="notice info">${esc(r.note || '无法对比')}</div>
        <div class="row"><button class="primary" data-exec-scheme="${sid}" data-import="${importId}">直接执行</button></div>`;
      bindExec(host);
    } catch (e) { host.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
  }));

  function bindExec(host) {
    host.querySelectorAll('[data-exec-scheme]').forEach((b) => (b.onclick = async () => {
      try {
        const r = await api(`/api/schemes/${b.dataset.execScheme}/execute`, { body: { importId: Number(b.dataset.import) } });
        toast(`已生成数据集 #${r.datasetId}：${r.stats.rows} 行`);
        location.hash = `#/datasets?open=${r.datasetId}`;
      } catch (e) { toast(e.message, 4000); }
    }));
    host.querySelectorAll('[data-adjust]').forEach((b) => (b.onclick = () => {
      const importId = $(`[data-check-import="${b.dataset.adjust}"]`).value;
      location.hash = `#/extract?scheme=${b.dataset.adjust}&import=${importId}`;
    }));
  }
}

/* ---------------- 数据集页 ---------------- */
async function renderDatasets(q) {
  const datasets = await api('/api/datasets');
  const openId = Number(q.get('open')) || datasets[0]?.id;
  app.innerHTML = `
    <h2>数据集</h2>
    <div class="grid cols">
      <div class="panel">
        ${datasets.map((d) => `
          <div class="endpoint-item ${d.id === openId ? 'active' : ''}" data-ds="${d.id}">
            <b>#${d.id} ${esc(d.name)}</b>
            <div>
              <span class="chip">${d.row_count} 行</span>
              ${d.failure_count ? `<span class="chip warn">跳过/失败 ${d.failure_count}</span>` : ''}
              <span class="chip">${esc(d.import_name)}</span>
              ${d.scheme_name ? `<span class="chip info">方案：${esc(d.scheme_name)}</span>` : ''}
            </div>
          </div>`).join('') || '<p class="muted">还没有数据集，请到「提取」页执行。</p>'}
      </div>
      <div class="panel" id="dsDetail"><p class="muted">选择左侧数据集查看。</p></div>
    </div>`;
  app.querySelectorAll('[data-ds]').forEach((el) => (el.onclick = () => { location.hash = `#/datasets?open=${el.dataset.ds}`; }));
  if (openId) await showDataset(openId);
}

async function showDataset(id, offset = 0) {
  const d = await api(`/api/datasets/${id}?offset=${offset}&limit=200`);
  const host = $('#dsDetail');
  const cols = d.rows.length ? [...new Set(d.rows.flatMap((r) => Object.keys(r.data)))] : [];
  const pages = Math.ceil(d.total / 200);
  host.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <h3 style="margin:0">#${d.id} ${esc(d.name)}</h3>
      <div class="row">
        <a href="/api/datasets/${id}/export?format=csv"><button>导出 CSV</button></a>
        <a href="/api/datasets/${id}/export?format=json"><button>导出 JSON</button></a>
        <button class="danger" id="delDs">删除</button>
      </div>
    </div>
    <p class="muted">共 ${d.total} 行 · 目标请求 ${d.stats.targets ?? '-'} · 跳过 ${d.stats.skipped ?? 0}
      ${(d.stats.warnings || []).map((w) => `<div class="notice warn">${esc(w)}</div>`).join('')}
      ${(d.stats.errors || []).map((e) => `<div class="notice err">${esc(e)}</div>`).join('')}
    </p>
    ${d.failures.length ? `<h3>失败 / 跳过明细（单独列出，未混入数据）</h3>
      <table><thead><tr><th>请求</th><th>类别</th><th>说明</th></tr></thead><tbody>
      ${d.failures.map((f) => `<tr><td class="mono">#${f.entry_id} ${esc(f.method || '')} ${esc(f.url || '')} ${f.status ? `(${f.status})` : ''}</td>
        <td><span class="chip ${f.reason === 'failed' ? 'err' : 'warn'}">${esc(reasonText(f.reason))}</span></td><td class="muted">${esc(f.detail || '')}</td></tr>`).join('')}
      </tbody></table>` : ''}
    <h3>数据行 ${offset + 1}–${Math.min(offset + 200, d.total)} / ${d.total}</h3>
    <div class="scroll-x"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${d.rows.map((r) => `<tr>${cols.map((c) => `<td class="mono">${esc(r.data[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    ${pages > 1 ? `<div class="row" style="margin-top:8px">${Array.from({ length: pages }, (_, i) => `<button class="small ${i * 200 === offset ? 'primary' : ''}" data-page="${i * 200}">${i + 1}</button>`).join('')}</div>` : ''}`;
  $('#delDs').onclick = async () => {
    if (!confirm('删除该数据集？')) return;
    await api(`/api/datasets/${id}`, { method: 'DELETE' });
    location.hash = '#/datasets';
    route();
  };
  host.querySelectorAll('[data-page]').forEach((b) => (b.onclick = () => showDataset(id, Number(b.dataset.page))));
}

route();
