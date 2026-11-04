# STRIDE OS

一个本地优先的跑步训练分析 Agent。支持用户自带模型 API、上传运动数据、查看跑步趋势，并基于确定性指标生成训练建议。

## 功能

- 支持本地分析，无需 API Key 即可运行。
- 支持 OpenAI Responses API。
- 支持 Anthropic Messages API。
- 支持 DeepSeek、Kimi、千问及其他 OpenAI-compatible 接口。
- 支持 CSV、GPX、TCX 文件上传。
- 支持通过 OAuth 2.0 连接高驰 COROS MCP，并同步训练记录。
- 使用 SQLite 保存活动、导入记录和对话。
- 提供训练总览、训练记录、训练日历和 AI 教练四个独立页面；训练记录支持单次训练详情、路线轨迹和详细指标。
- 支持多会话、短期摘要记忆、跑者档案和长期记忆检索。
- 新的同主题长期记忆会自动替代旧记忆，已替代内容保留审计状态但不进入模型上下文。
- 外部模型回答后自动抽取用户明确表达的长期事实（目标、偏好、伤病、决定、档案），去重后写入长期记忆；本地分析模式不会自动写入。
- 提供有界 Agent Loop、工具注册、执行轨迹、取消、重试和 SSE 状态推送。
- 外部模型优先使用 OpenAI Responses、Anthropic Messages 和 OpenAI-compatible 原生 function calling；接口不支持时自动降级到 JSON 工具协议。
- 工具参数按 JSON Schema 严格校验；非法参数会回传给模型重试，取消信号会中断正在执行的工具和 COROS 请求。
- 模型空响应、连接失败或无效工具输出时自动切换本地训练分析保底。
- Agent 外部模型默认预留 4096 输出 Token，检测到长度截断时使用完整本地保底。
- 支持计划预览、一次性确认令牌，以及确认后写入本地日历和高驰课程。
- 训练日历支持 AI 生成、冲突提示、逐日预览、勾选确认、完成和跳过记录。
- 提供本地训练知识检索、运行追踪、87 项自动化测试和 30 条 Agent 固定评估集。
- 基于最近多次跑步建立个人心率档案；心率只提供过程建议，不参与计划难度、强度次数或跑量决策。
- 训练计划按周跑量和比赛日期决策：距比赛超过 30 天至少安排两次速度或节奏刺激，30 天内转向比赛配速和专项长距离。
- 默认保留 90 天 Agent 运行审计（Run 与工具步骤），启动时和每日自动清理，可用 `AUDIT_RETENTION_DAYS` 调整。
- 内置 14 条演示跑步数据。
- 提供周跑量趋势、配速、心率、训练负荷和活动列表。
- 首次成功上传数据后自动移除演示数据。
- 内置基于吴向东、萨巴斯蒂安·萨维公开训练习惯的 `elite-marathon-coach` Skill。

## 技术栈

| 层级 | 使用技术 | 主要用途 |
|---|---|---|
| 前端 | HTML5、CSS、原生 JavaScript ES Modules、SSE | 四页面 SPA、响应式布局、训练图表、Agent 执行轨迹和流式状态 |
| 后端 | Node.js 24、Express 5、模块化路由 | HTTP API、SSE、文件上传、模型调用和 Agent Runtime |
| 数据库 | SQLite、`node:sqlite`、FTS5、WAL | 活动、会话、长期记忆、训练日历、Run、工具步骤和后台任务 |
| Agent | 自研有界 Agent Loop、原生 function calling、工具注册表、Context Engine、Reflection | 原生/JSON 工具选择、观察回传、上下文预算、摘要、反思和运行终止 |
| 记忆与检索 | SQLite FTS5、中文关键词、特征哈希向量、余弦相似度 | 短期摘要记忆、跑者档案、长期记忆和轻量混合知识检索 |
| 模型接入 | OpenAI SDK、Anthropic SDK、OpenAI-compatible | OpenAI、Anthropic、DeepSeek、Kimi、千问和自定义模型 |
| 运动数据 | `csv-parse`、`fast-xml-parser`、Multer | CSV、GPX、TCX 解析和最大 10 MB 文件上传 |
| 高驰接入 | OAuth 2.0 + PKCE、MCP Streamable HTTP、JSON-RPC | 授权、运动记录同步和确认后的高驰课程写入 |
| 密钥安全 | AES-256-GCM、本地配置文件权限 | 加密保存高驰令牌；模型 API Key 不写入数据库和浏览器存储 |
| 测试与评估 | Node.js Test Runner、87 项自动化测试、30 条固定 Agent 用例 | 数据解析、指标、心率档案、训练决策、记忆提取与属性级替代、Agent Loop、原生工具调用、SSE 续传、工具 Schema、审计清理、确认写入、取消传播和模型异常处理 |
| 运行方式 | 本地 Node.js 服务、浏览器访问、可选 APP_PASSWORD | 默认单用户本地运行；设置口令后可限制 API 访问 |

项目没有使用 React、Vue 等前端框架，前端由原生 DOM 和 ES Modules 实现；Agent 运行时也是项目内自研，没有依赖 LangChain、LangGraph 等多 Agent 框架。

## 快速启动

```bash
cd running-agent
npm install
npm run dev
```

打开 [http://localhost:4173](http://localhost:4173)。

生产式启动：

```bash
npm start
```

测试：

```bash
npm test
```

Agent 评估需要先启动服务：

```bash
npm run evaluate:agent
```

默认评估使用本地分析模式。设置以下环境变量可使用真实外部模型：

```powershell
$env:EVAL_MODEL_API_KEY = "..."
$env:EVAL_MODEL_PROVIDER = "openai-compatible"
$env:EVAL_MODEL_BASE_URL = "https://api.deepseek.com/v1"
$env:EVAL_MODEL_NAME = "deepseek-chat"
npm run evaluate:agent
```

示例数据位于 `samples/demo-runs.csv`，可以直接拖入上传面板。

## 模型配置

模型密钥只在当前请求中发送给 Node 服务，不写入 SQLite、`localStorage`、URL 或日志。页面只保存厂商、模型名、Base URL 和接口类型。

| 服务 | 接口类型 | 默认 Base URL |
|---|---|---|
| 本地分析 | 无 | 无 |
| OpenAI | Responses | `https://api.openai.com/v1` |
| Anthropic | Messages | `https://api.anthropic.com` |
| DeepSeek | Chat Completions | `https://api.deepseek.com/v1` |
| Kimi | Chat Completions | `https://api.moonshot.cn/v1` |
| 千问 | Chat Completions | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

模型名称需要填写账户当前可用的模型 ID，项目中不写死具体模型。

## CSV 格式

```csv
started_at,distance_km,duration_sec,avg_pace_sec_per_km,avg_heart_rate,max_heart_rate,cadence,notes
2026-11-01T07:30:00+08:00,10,3120,312,156,178,176,周末长距离
```

必填字段：

- `started_at`
- `distance_km`
- `duration_sec` 或 `avg_pace_sec_per_km` 至少一个

页面可从 `/api/imports/template.csv` 下载模板。

## 高驰 COROS MCP

点击工作台右侧“高驰 COROS”，选择账号所在地区后连接。应用会：

1. 通过高驰 `connect/register` 动态注册本地 OAuth 客户端。
2. 使用 OAuth 2.0 Authorization Code + PKCE 跳转到高驰官方登录页。
3. 将访问令牌和刷新令牌使用 AES-256-GCM 加密后保存到 SQLite。
4. 调用无状态 MCP 工具 `querySportRecords` 同步训练记录，只保留跑步类活动（100–103），步行、骑行、游泳、力量等记录会被忽略。
5. 对前 12 条有活动标识的记录调用 `getActivityDetail` 补充心率等数据。
6. 与已有上传记录按开始时间（±3 分钟）、距离（±1.5%）和时长（±3%）跨来源去重，避免同一次跑步重复入库。

支持的服务地址：

- 自动选择：`https://mcp.coros.com/mcp`
- 中国大陆：`https://mcpcn.coros.com/mcp`
- 欧洲：`https://mcpeu.coros.com/mcp`
- 美国及其他地区：`https://mcpus.coros.com/mcp`

默认回调地址根据当前浏览器访问地址生成，例如 `http://localhost:4175/api/auth/coros/callback`。如果使用反向代理或固定域名，请设置：

```bash
PUBLIC_BASE_URL=https://your-domain.example
```

令牌加密使用 `data/master.key` 或环境变量：

```bash
MASTER_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
```

断开连接会撤销并清除本地令牌，但保留已经同步到工作台的训练记录。

高驰官方资料：

- [Build on COROS MCP](https://support.coros.com/hc/en-us/articles/53181619102996-Build-on-COROS-MCP)
- [COROS MCP GitHub](https://github.com/coroslab/COROS-MCP)
- [COROS MCP 工具参考](https://github.com/coroslab/COROS-MCP/blob/main/docs/zh/tools.md)

## 数据和安全

- SQLite 文件位于 `data/running-agent.db`。
- 上传文件使用内存处理，最大 10 MB，不长期保存原始文件。
- 活动通过开始时间、距离和时长生成内容指纹，同一来源的重复记录会被跳过；不同来源的同一次跑步也会按时间和距离容差去重。
- 服务默认只监听 `127.0.0.1`，可用 `HOST=0.0.0.0` 显式对外开放。
- 所有修改状态的 `/api/` 请求都会校验 `Origin`，跨站请求返回 403。
- 默认不启用登录，只适合本机或可信内网；设置 `APP_PASSWORD` 后会启用口令登录、HttpOnly 会话和登录限流。
- 即使启用口令，当前仍是单用户数据模型，不是完整多租户系统。
- 用户自定义模型 Base URL 会由服务端发起请求。公网部署应设置 `MODEL_BASE_URL_ALLOWLIST`，并使用 `BLOCK_PRIVATE_MODEL_URLS=true` 阻止本机和内网地址。
- Agent 运行审计默认保留 90 天，可通过 `AUDIT_RETENTION_DAYS` 调整；清理只删除过期的 `agent_runs` 和 `agent_steps`，不影响会话、长期记忆和训练数据。
- COROS MCP 令牌已加密保存，但 `data/master.key` 仍需与数据库一同保护。
- Agent 输出属于训练参考，不构成医疗建议。

## 训练规划 Skill

Skill 位置：

```text
skills/elite-marathon-coach/
├─ SKILL.md
└─ references/
   ├─ evidence.md
   └─ planning-rules.md
```

`SKILL.md` 定义证据边界、决策顺序、普通跑者换算规则和输出格式。`planning-rules.md` 定义 7 天、4 周、减量和质量课模板。`evidence.md` 保存公开来源与事实/推断的区分。

接入方式：

- 本地分析模式根据当前跑量、最长距离和距离比赛天数生成未来 7 天计划。
- 外部模型通过 `buildSystemPrompt()` 自动加载 Skill 和规划规则。
- 训练计划不使用精英跑者的绝对配速；没有阈值数据时使用主观用力程度。
- 心率档案只用于训练过程建议。强度课中可根据实时感觉降组、减速或停止，但不会仅因历史心率偏高取消计划中的强度。
- 不把萨维约 200 公里/周或吴向东每周 12 次训练直接套给普通跑者。

公开训练资料主要来源：

- [吴向东肯尼亚训练采访（98跑 / 新浪体育）](https://k.sina.com.cn/article_2681606957_9fd6132d02001e1ky.html)
- [Sabastian Sawe 训练与人物采访（Runner's World UK）](https://www.runnersworld.com/uk/training/motivation/a66060636/sabastian-sawe/)
- [BBC Sport: Sabastian Sawe 马拉松训练与比赛报道](https://www.bbc.com/sport/athletics/articles/cp383n09030o)
- [World Athletics: Sabastian Sawe 官方档案](https://worldathletics.org/athletes/kenya/sabastian-kimaru-sawe-14833335)

## 项目结构

```text
running-agent/
├─ server.js
├─ src/
│  ├─ api/
│  │  ├─ data-routes.js
│  │  ├─ coros-routes.js
│  │  └─ model-routes.js
│  ├─ db.js
│  ├─ metrics.js
│  ├─ parsers.js
│  ├─ coach.js
│  ├─ training-plan.js
│  ├─ plan-constraints.js
│  ├─ model-gateway.js
│  ├─ secret-store.js
│  ├─ coros.js
│  ├─ auth.js
│  ├─ origin-guard.js
│  ├─ agent-api.js
│  ├─ agent-runtime.js
│  ├─ agent-store.js
│  ├─ agent-tools.js
│  ├─ memory-extraction.js
│  ├─ tool-schema.js
│  ├─ local-planner.js
│  ├─ context-engine.js
│  ├─ knowledge-rag.js
│  ├─ skill-loader.js
│  └─ job-runner.js
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ scripts/
│  └─ evaluate-agent.mjs
├─ samples/
│  └─ demo-runs.csv
├─ skills/
│  └─ elite-marathon-coach/
├─ test/
└─ data/
```

## 当前边界

高驰 COROS MCP 已完成 OAuth、跑步记录同步和确认后的跑步课程写入。文件上传始终是可用的替代路径；当前不下载 FIT 文件，不写入休息、活动度或力量课程，也不修改和删除高驰已有课程。

Agent 训练知识检索使用词项、中文二元组、本地特征哈希向量和余弦相似度，不依赖外部向量数据库；当前是单 Agent 架构，不包含 A2A、ANP 或多 Agent 调度。
