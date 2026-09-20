# ls-model-midway

部署在可访问模型官方 API 的节点上的 HTTP 流式中转。支持 Tripo3D 及其他
HTTP API，通过配置映射 URL，业务参数和响应内容透传。Node.js 20.12.0+，无第三方依赖。

## 使用 .env 启动

在 `ls-model-midway` 目录下创建 `.env`（可参考 `.env.example`）：

```dotenv
UPSTREAM_ROUTES={"tripo":"https://openapi.tripo3d.ai"}
PORT=3000
```

然后在该目录执行 `npm start`。启动时自动加载项目根目录的 `.env`，已设置的
系统或部署平台环境变量优先于文件中的同名变量。修改 `.env` 后需要重启。
`.env` 已加入 Git 忽略规则，不应提交真实配置。

## 多供应商配置（推荐）

```bash
UPSTREAM_ROUTES='{"tripo":"https://openapi.tripo3d.ai","yunwu":"https://api.example.com"}' PORT=3000 npm start
```

将云雾示例地址替换为实际地址。新增供应商只需在 JSON 中增加一项并重启服务。
名称只允许字母、数字、下划线和连字符。上游只能使用 HTTP/HTTPS，可以包含基础路径，
不能包含用户名、密码、查询参数或 fragment。

| 国内调用地址 | 转发目标 |
| --- | --- |
| `/tripo/v3/generation/text-to-model` | `https://openapi.tripo3d.ai/v3/generation/text-to-model` |
| `/tripo/v3/tasks/{task_id}` | `https://openapi.tripo3d.ai/v3/tasks/{task_id}` |
| `/tripo/v3/upload` | `https://openapi.tripo3d.ai/v3/upload` |
| `/yunwu/v1/chat/completions` | `https://api.example.com/v1/chat/completions` |

路径第一段用于选择上游，转发时移除；剩余路径和查询串原样追加到上游基础路径。
例如配置 `{"other":"https://example.com/api"}`，`/other/v1/models` 转发为
`https://example.com/api/v1/models`。未配置的前缀返回 404，调用方不能指定任意目标主机。

## Tripo 调用示例

依据 [Tripo 官方文档](https://developers.tripo3d.ai/zh/docs) 的 v3 API。
把客户端的 `https://openapi.tripo3d.ai` 替换成 `https://你的中转域名/tripo`，
其余路径、参数和官方 API Key 不变。API Key 由你的业务后端持有并传入。

创建任务（在 shell 中预先设置 `TRIPO_API_KEY`）：

```bash
curl 'https://你的中转域名/tripo/v3/generation/text-to-model' \
  -H "Authorization: Bearer ${TRIPO_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"A cat wearing a spacesuit","model":"v3.1-20260211","texture":true}'
```

使用返回的任务 ID 查询：

```bash
curl "https://你的中转域名/tripo/v3/tasks/${TASK_ID}" \
  -H "Authorization: Bearer ${TRIPO_API_KEY}"
```

图片上传等其他接口也只替换 URL 前缀，字段以官方文档为准。程序不绑定模型版本，
不解析 JSON 或 multipart，也不轮询任务。若使用旧版 API，可单独配置对应旧版上游。

## 单上游模式（兼容原配置）

不设置 `UPSTREAM_ROUTES` 时使用：

```bash
UPSTREAM_BASE_URL=https://openapi.tripo3d.ai PORT=3000 npm start
```

此时调用 `/v3/generation/text-to-model`，无需 `/tripo` 前缀。原有云雾部署可继续使用
原 `UPSTREAM_BASE_URL`。同时设置两个变量时，以 `UPSTREAM_ROUTES` 为准，未知路由不会回退。

| 环境变量 | 说明 |
| --- | --- |
| `UPSTREAM_ROUTES` | 非空 JSON 对象，供应商名称到固定上游地址的映射 |
| `UPSTREAM_BASE_URL` | 未设置路由映射时必填的单上游地址 |
| `PORT` | 默认 `3000`，范围 `0`–`65535` |

服务自动读取项目根目录的 `.env`，也支持部署平台或 shell 注入，`.env.example` 提供配置模板。
没有 `.env` 文件时继续使用系统环境变量。
配置错误时启动失败。启动日志仅包含端口、路由名称和上游 origin。

## 透传边界与部署

- 保留 HTTP 方法、原始路径和查询串、Authorization 等端到端请求头、原始请求体。
- 根据 HTTP 代理要求重建 Host、过滤逐跳头；HTTP 分块等传输封装可由 Node.js 重建。
- 原样返回上游状态码、端到端响应头与正文，支持 JSON、SSE、multipart 和二进制流。
- 连接失败返回 502；不自动重试，避免重复创建付费任务。
- 响应中的下载 URL、上传到对象存储的预签名 URL 以及重定向 Location 不会改写。
  这些地址如果也无法直连，需要另外配置对应的访问路径；API 中转不会自动代理这些请求。
- 沿用原服务的网络白名单访问控制，没有应用层鉴权。部署在可访问官方 API 的节点，
  通过防火墙或网关限制业务后端来源，并在网关终止 HTTPS。
- 不记录请求头、请求体或响应体，不提供内容转换、缓存、限流或模型业务校验。

## 验证

```bash
npm test
```

测试使用本地上游验证多供应商分流、任务 JSON 和上传字节透传、Authorization、原始查询串、
未知路由、非法配置、流式响应、上游异常和单上游兼容性，不消耗官方模型额度。
