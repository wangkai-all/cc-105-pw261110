# HAR 数据提取工具

离线工具：导入浏览器导出的 HAR，按接口/时间/状态码浏览请求，把 JSON 响应点选配置后提取成数据表，支持分页关联、重试去重、嵌套数组展开、敏感信息脱敏与提取方案复用。

**纯本地运行，不向原站点发送任何请求。** 零 npm 依赖（Node ≥ 22.5，使用内置 `node:sqlite`）。

## 快速开始

```bash
npm run samples   # 生成本地样本 HAR（重复分页/错误响应/缺失响应体/base64）
npm start         # 启动 http://127.0.0.1:8734
npm test          # 运行单元测试
```

打开页面后：「导入」页上传 HAR 或一键导入样本 →「请求」页浏览 →「提取」页点选配置并预览 → 批量执行为「数据集」→ 导出 CSV/JSON。「方案」页保存的配置可对另一份 HAR 先做结构差异检查再执行。

## 功能与规则

### 请求浏览
- 按接口（方法+路径）分组，可按状态码、响应状态（可用 JSON / 失败 / 响应体缺失）、URL 关键字、时间筛选。
- 请求详情展示脱敏后的请求头、参数、请求体与解码后的响应体 JSON 树。

### 分页与去重
- 同一接口下，**除分页参数外其余参数完全一致**的请求关联为同一分页序列；分页参数自动识别（常见翻页参数名，或组内变化的数字参数），恒定参数作为关联键。
- 序列内响应体哈希相同的请求判定为**重试重复**，提取时自动去重（保留首条）。
- **失败响应**（状态码 0 或 ≥400）与**响应体缺失**的请求不参与提取，在预览和数据集中单独列出。

### 响应体处理
- `content.encoding: "base64"` 自动解码为文本再解析 JSON。
- HAR 未保存响应体（`content.text` 缺失）时明确标记「响应体缺失」，**绝不补造数据**。

### 嵌套数组展开
- 主数组路径、输出字段、请求参数列均通过 JSON 树/复选框点选。
- 展开嵌套子数组前，预览显示「基础行数 → 展开后行数」的增量。
- 子数组展开必须选择**父键/子键**，每行保留父子对应关系。
- 同一父级下的**并列子数组**未设置关联键时禁止执行（防止交叉组合产生错误数据）；设置关联键后按键 LEFT JOIN 合并，不做笛卡尔积。

### 脱敏（安全边界）
- 导入时一次性清除：默认清单（`Cookie`、`Authorization`、`Set-Cookie` 等请求/响应头，常见 token 类查询/表单参数，JSON 体中的敏感键）+ 用户配置追加的字段。默认清单强制生效，用户配置只能追加。
- URL 中的敏感查询参数重写为 `<已清除>`；非 JSON 请求体文本中的敏感 `name=value` 打码。
- 原始 HAR 不入库；页面、CSV/JSON 导出、SQLite 持久化记录均只含脱敏数据。

### 提取方案
- 保存方案时记录接口结构指纹（字段路径 + 类型）。
- 对另一份 HAR 应用方案前，先对比结构差异：新增字段、缺失字段、类型变化，并提示方案引用但新结构缺失的字段；确认后再执行或跳转提取页调整。

## 本地样本

| 文件 | 内容 |
| --- | --- |
| `samples/shop-orders-a.har` | 订单分页：base64 响应体、第 2 页重试重复、第 3 页 500 错误、第 4 页首次响应体缺失（重试成功）、敏感头/敏感参数/敏感 JSON 键 |
| `samples/shop-orders-b.har` | 同接口另一次导出：`total→totalAmount` 改名、新增 `currency`、移除 `remark`，用于方案结构差异检查 |

## 目录结构

```
server/    index.js(HTTP+API) har.js(解析+脱敏) pagination.js(分页序列) extract.js(提取引擎) db.js(SQLite)
public/    单页应用（导入/请求/提取/方案/数据集）
scripts/   generate-samples.mjs 样本生成
samples/   本地样本 HAR
test/      node:test 单元测试
data/      运行期生成的 SQLite 库（已 gitignore）
```

## API 摘要

`POST /api/imports`（body: `{name, harText, sanitizeConfig}`）、`POST /api/imports/sample`、`GET /api/imports/:id/endpoints`、`GET /api/imports/:id/entries`、`GET /api/entries/:id`、`POST /api/preview`、`POST /api/extract`、`GET|POST /api/schemes`、`POST /api/schemes/:id/check`、`POST /api/schemes/:id/execute`、`GET /api/datasets/:id`、`GET /api/datasets/:id/export?format=csv|json`。
