// 提取引擎：路径解析、嵌套数组展开、结构指纹与差异对比。
// 全部为纯函数，便于单元测试。任何输入异常都以错误/警告形式返回，绝不编造数据。

/** 把 "a.b[0].c" 形式的路径解析为段数组 ['a','b',0,'c'] */
export function parsePath(path) {
  if (path == null || path === '') return [];
  const segs = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(String(path))) !== null) {
    if (m[2] !== undefined) segs.push(Number(m[2]));
    else segs.push(m[1]);
  }
  return segs;
}

/** 按路径段取值；路径不存在返回 undefined */
export function getByPath(obj, segs) {
  let cur = obj;
  for (const s of segs) {
    if (cur == null) return undefined;
    cur = cur[s];
  }
  return cur;
}

/** 收集对象中所有数组节点的路径（用于前端点选数组路径） */
export function collectArrayPaths(node, base = '', out = [], depth = 0) {
  if (depth > 12 || node == null) return out;
  if (Array.isArray(node)) {
    out.push({ path: base, length: node.length, sampleType: typeOf(node[0]) });
    // 继续深入第一个元素，发现嵌套数组
    if (node.length > 0) collectArrayPaths(node[0], `${base}[]`, out, depth + 1);
    return out;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      collectArrayPaths(v, base ? `${base}.${k}` : k, out, depth + 1);
    }
  }
  return out;
}

export function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * 结构指纹：对 arrayPath 指向的数组元素采样，得到 字段路径 -> 类型集合。
 * 用于保存方案时记录结构、对新 HAR 做结构差异检查。
 */
export function fingerprint(body, arrayPath, sampleLimit = 50) {
  const items = getByPath(body, parsePath(arrayPath));
  if (!Array.isArray(items)) return null;
  const fields = new Map(); // path -> Set(types)
  const walk = (val, prefix, depth) => {
    if (depth > 8) return;
    const t = typeOf(val);
    if (prefix) {
      if (!fields.has(prefix)) fields.set(prefix, new Set());
      fields.get(prefix).add(t);
    }
    if (t === 'object') {
      for (const [k, v] of Object.entries(val)) walk(v, prefix ? `${prefix}.${k}` : k, depth + 1);
    } else if (t === 'array' && val.length > 0) {
      walk(val[0], prefix ? `${prefix}[]` : '[]', depth + 1);
    }
  };
  for (const item of items.slice(0, sampleLimit)) walk(item, '', 0);
  const obj = {};
  for (const [p, types] of fields) obj[p] = [...types].sort();
  return { arrayPath, itemCount: items.length, fields: obj };
}

/** 合并多个响应体的指纹（同一接口多个分页） */
export function mergeFingerprints(fps) {
  const fields = {};
  let itemCount = 0;
  let found = 0;
  for (const fp of fps) {
    if (!fp) continue;
    found++;
    itemCount += fp.itemCount;
    for (const [p, types] of Object.entries(fp.fields)) {
      fields[p] = [...new Set([...(fields[p] || []), ...types])].sort();
    }
  }
  return found ? { itemCount, fields } : null;
}

/** 结构差异对比：返回 新增/缺失/类型变化 的字段列表 */
export function diffFingerprints(baseFp, nextFp) {
  const added = [];   // 新 HAR 有、方案没有
  const removed = []; // 方案有、新 HAR 没有
  const typeChanged = [];
  const a = baseFp?.fields || {};
  const b = nextFp?.fields || {};
  for (const p of Object.keys(b)) {
    if (!(p in a)) added.push(p);
    else if (JSON.stringify(a[p]) !== JSON.stringify(b[p])) {
      typeChanged.push({ path: p, from: a[p], to: b[p] });
    }
  }
  for (const p of Object.keys(a)) if (!(p in b)) removed.push(p);
  return { added, removed, typeChanged, compatible: removed.length === 0 && typeChanged.length === 0 };
}

/**
 * 展开核心：从单个响应体按配置抽行。
 * config = {
 *   arrayPath: 'data.list',
 *   fields: [{path, as}],
 *   nestedArrays: [{ id, path(相对父项), parentKey, childKey, joinWith, joinParentKey, joinChildKey, fields:[{path,as}] }]
 * }
 * 规则：
 *  - 无主数组 → 报错；
 *  - 同一父级下多个子数组且未配置 joinWith 关联键 → 报错（防止交叉展开产生错误组合）；
 *  - joinWith 的子数组按 键匹配 LEFT JOIN 到目标子数组的行上，不做笛卡尔积。
 */
export function extractRows(body, config) {
  const errors = [];
  const warnings = [];
  const items = getByPath(body, parsePath(config.arrayPath));
  if (!Array.isArray(items)) {
    return { rows: [], errors: [`数组路径 "${config.arrayPath}" 不存在或不是数组`], warnings };
  }
  const nested = config.nestedArrays || [];
  // 校验并列子数组
  const byParent = new Map();
  for (const n of nested) {
    const key = parentOf(n.path);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(n);
  }
  for (const [parent, list] of byParent) {
    if (list.length > 1) {
      // 并列子数组：至多允许一个作为锚点不带关联键，其余必须 joinWith 到已展开的数组
      const unjoined = list.filter((n) => !n.joinWith || !n.joinParentKey || !n.joinChildKey);
      if (unjoined.length > 1) {
        errors.push(
          `父级 "${parent || '(主数组项)'}" 下存在 ${list.length} 个并列子数组（${list.map((n) => n.path).join('、')}），` +
            `未全部设置关联键，展开会产生交叉组合。请为并列数组选择父子关联键，或拆分为多个方案。`
        );
      }
    }
  }
  if (errors.length) return { rows: [], errors, warnings };

  // 主行：主数组项 + 主字段
  let rows = items.map((item) => ({
    __item: item,
    out: pickFields(item, config.fields || []),
  }));

  // 逐层展开子数组：先普通展开，再按键 join（保证 join 目标列已存在）
  const plain = nested.filter((n) => !n.joinWith);
  const joined = nested.filter((n) => n.joinWith);
  for (const n of plain) rows = expandNested(rows, n, warnings);
  for (const n of joined) rows = joinNested(rows, n, warnings);
  return { rows: rows.map((r) => r.out), errors, warnings };
}

function parentOf(relPath) {
  const idx = relPath.lastIndexOf('.');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

function pickFields(item, fields) {
  const out = {};
  for (const f of fields) {
    const v = getByPath(item, parsePath(f.path));
    out[f.as || f.path] = v === undefined ? null : normalize(v);
  }
  return out;
}

function normalize(v) {
  if (v === null || typeof v !== 'object') return v;
  return JSON.stringify(v); // 对象/数组值序列化，保证表格单元格为标量
}

/** 普通展开：当前每一行 × 其子数组元素（父子键保留对应关系） */
function expandNested(rows, n, warnings) {
  const next = [];
  const parentSegs = parsePath(parentOf(n.path));
  const childName = n.path.slice(parentOf(n.path).length ? parentOf(n.path).length + 1 : 0);
  for (const row of rows) {
    const parentItem = getByPath(row.__item, parentSegs) ?? row.__item;
    const children = parentItem?.[childName];
    if (!Array.isArray(children) || children.length === 0) {
      // 子数组为空：保留父行，子字段补 null，父子键仍写入
      const out = { ...row.out };
      if (n.parentKey) out[n.parentKeyAs || `父键.${n.parentKey}`] = normalize(getByPath(parentItem, parsePath(n.parentKey)) ?? null);
      for (const f of n.fields || []) out[f.as || f.path] = null;
      if (n.childKey) out[n.childKeyAs || `子键.${n.childKey}`] = null;
      next.push({ __item: row.__item, out });
      continue;
    }
    for (const child of children) {
      const out = { ...row.out };
      if (n.parentKey) out[n.parentKeyAs || `父键.${n.parentKey}`] = normalize(getByPath(parentItem, parsePath(n.parentKey)) ?? null);
      if (n.childKey) out[n.childKeyAs || `子键.${n.childKey}`] = normalize(getByPath(child, parsePath(n.childKey)) ?? null);
      Object.assign(out, pickFields(child, n.fields || []));
      next.push({ __item: row.__item, out });
    }
  }
  return next;
}

/** 键匹配合并：把 joinWith 的子数组按键 LEFT JOIN 到已展开的行上，避免交叉积 */
function joinNested(rows, n, warnings) {
  const parentSegs = parsePath(parentOf(n.path));
  const childName = n.path.slice(parentOf(n.path).length ? parentOf(n.path).length + 1 : 0);
  // 按 __item 分组：同一父项的已展开行共享一份待 join 的子数组索引
  const indexCache = new Map();
  const next = [];
  for (const row of rows) {
    const parentItem = getByPath(row.__item, parentSegs) ?? row.__item;
    const children = Array.isArray(parentItem?.[childName]) ? parentItem[childName] : [];
    let idx = indexCache.get(row.__item);
    if (!idx) {
      idx = new Map();
      for (const c of children) {
        const k = JSON.stringify(getByPath(c, parsePath(n.joinChildKey)) ?? null);
        if (!idx.has(k)) idx.set(k, []);
        idx.get(k).push(c);
      }
      indexCache.set(row.__item, idx);
    }
    // 当前行上被 join 的目标键值（来自 joinWith 数组展开时写入的列）
    const keyVal = row.out[n.joinParentKey];
    const matches = idx.get(JSON.stringify(keyVal ?? null)) || [];
    if (matches.length === 0) {
      const out = { ...row.out };
      for (const f of n.fields || []) out[f.as || f.path] = null;
      next.push({ __item: row.__item, out });
    } else if (matches.length === 1) {
      next.push({ __item: row.__item, out: { ...row.out, ...pickFields(matches[0], n.fields || []) } });
    } else {
      warnings.push(`关联键 "${n.joinChildKey}" 值 ${JSON.stringify(keyVal)} 匹配到 ${matches.length} 条子记录，已展开为多行`);
      for (const m of matches) {
        next.push({ __item: row.__item, out: { ...row.out, ...pickFields(m, n.fields || []) } });
      }
    }
  }
  return next;
}

/** 预览：统计展开前后行数，供前端提示“行数增加” */
export function previewRowCounts(bodies, config) {
  let base = 0;
  let expanded = 0;
  const errors = [];
  const warnings = [];
  for (const body of bodies) {
    const items = getByPath(body, parsePath(config.arrayPath));
    base += Array.isArray(items) ? items.length : 0;
    const r = extractRows(body, config);
    expanded += r.rows.length;
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  return { baseRows: base, expandedRows: expanded, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
