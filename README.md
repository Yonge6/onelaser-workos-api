# OneLaser 工作与成果 API

中文 · [English](README.en.md)

员工任务、OKR、成果提交和人工验收的后台研发 MVP。使用 Node.js、TypeScript、Fastify 和 PostgreSQL 查询；本地与测试可使用 PGlite，正式数据库连接使用 `pg` 适配器。

[后台仓库](https://github.com/Yonge6/onelaser-workos-api) · [前端仓库](https://github.com/Yonge6/onelaser-workos) · [前端交互演示](https://yonge6.github.io/onelaser-workos/)

**当前没有公开部署的 API 服务。** 前端演示仍将记录保存在浏览器 `localStorage`，尚未调用本仓库接口。虚构数据仅用于研发验证；钉钉身份认证、AI 评审和通知发送尚未接入。

## 本地运行

需要 Node.js 22 或更新版本，推荐 Node.js 24。以下命令适用于 macOS、Linux 或兼容的 Shell：

```sh
git clone https://github.com/Yonge6/onelaser-workos-api.git
cd onelaser-workos-api
npm ci
npm run typecheck
npm test
npm run build
npm start
```

服务默认监听 `127.0.0.1:3001`。默认不导入演示数据、不启用开发登录。配置使用进程环境变量；`.env.example` 仅说明配置项，复制为 `.env` 不等于自动加载。

需要体验虚构账号时，在当前终端显式开启开发模式：

```sh
export NODE_ENV=development
export HOST=127.0.0.1 PORT=3001
export ALLOW_DEV_LOGIN=true SEED_DEMO=true
export DEV_LOGIN_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export PGLITE_DATA_DIR=.runtime/pglite
npm run dev
```

`DEV_LOGIN_SECRET` 至少 32 字符，开发登录需要同时提交该值。不要提交真实配置文件、会话令牌或数据库文件。`NODE_ENV=production` 禁止开发登录；生产配置必须提供 PostgreSQL 连接，不能用 PGlite 作为多人生产数据库。真实身份接入尚未完成，因此此版本不是可直接投入企业使用的完整后台。

## 虚构账号

只有显式设置 `SEED_DEMO=true` 才会导入这些样本：

| ID | 姓名 | 部门 | 角色 |
| --- | --- | --- | --- |
| `m1` | 林楠 | 市场 | 负责人 |
| `m2` | 陈一 | 市场 | 员工 |
| `m3` | 许夏 | 市场 | 员工 |
| `m4` | 周明 | 产品 | 负责人 |
| `m5` | 赵然 | 产品 | 员工 |
| `m6` | 顾安 | 产品 | 员工 |

角色和部门由服务端保存，不接受客户端自行声明。每次请求都会重新查询用户状态和范围；停用用户不能继续使用已有会话。

## 中英文响应

系统错误与提示默认使用中文。请求头设置 `Accept-Language: en` 时使用英文；设置 `Accept-Language: zh` 时使用中文。接口路径、JSON 字段名和 `error.code` 等机器标识固定使用英文，方便前后端稳定对接。员工填写的标题、说明、成果和验收意见按原文保存，不自动翻译。

```sh
curl --silent http://127.0.0.1:3001/capabilities -H 'Accept-Language: en'
```

## 登录与请求示例

开发登录从环境变量读取密钥，通过请求正文发送给本机服务：

```sh
export ACCESS_TOKEN="$(node -e 'process.stdout.write(JSON.stringify({userId:"m2",secret:process.env.DEV_LOGIN_SECRET}))' \
  | curl --fail --silent --show-error http://127.0.0.1:3001/auth/dev-login \
      -H 'Content-Type: application/json' --data-binary @- \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).accessToken))')"

curl --fail --silent --show-error http://127.0.0.1:3001/tasks \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

登录返回 `accessToken`、`tokenType` 和 `expiresAt`。会话使用随机令牌，数据库只保存令牌摘要；请勿将令牌写入 URL 或日志。

员工创建本人任务的正文示例：

```json
{
  "title": "完成产品内容初稿",
  "description": "提交可核对的内容与资料来源",
  "criteria": ["提供资料来源", "逐项说明验收情况"],
  "ownerId": "m2",
  "reviewerId": "m1",
  "dueAt": "2026-11-01T18:00:00+08:00",
  "krId": "kr2"
}
```

提交和验收需要先读取任务的最新 `version`。将它作为 `expectedVersion` 传入；审批请求的 `submissionVersion` 应使用任务返回的当前 `submission_version`。版本变化后旧请求会返回 `409`，调用方应重新读取并由用户确认。

## API 范围

除健康、能力说明和身份入口外，业务接口均需要 Bearer 会话。

| 方法与路径 | 当前行为 |
| --- | --- |
| `GET /health`、`GET /capabilities` | 健康状态与接入能力说明 |
| `POST /auth/dev-login` | 仅显式启用的开发模式可用，正文为 `userId`、`secret` |
| `GET /auth/dingtalk/start`、`GET/POST /auth/dingtalk/callback` | 尚未接入，返回 `501` |
| `DELETE /auth/session` | 撤销当前会话 |
| `GET /me` | 当前用户身份 |
| `GET /tasks`、`GET /tasks/:id` | 按本人或部门范围读取任务及成果记录 |
| `POST /tasks` | 创建任务并冻结最初截止日、验收标准与验收人 |
| `POST /tasks/:id/submissions` | 提交新成果版本，保存说明和可选 HTTPS 证据链接 |
| `POST /tasks/:id/reviews` | 指定负责人验收通过或退回补充 |
| `GET /objectives`、`GET /key-results` | 可见目标、KR 与业务进度 |
| `POST /key-results/:id/measurements` | 负责人记录实际值、来源和说明 |
| `POST /tasks/:id/analyze` | 模型尚未接入，返回 `501` |
| `GET /notifications/preview` | 生成当前可见范围的本地草稿，不发送 |
| `POST /notifications/send` | 发送通道尚未接入，返回 `501` |
| `GET /audit` | 按权限范围读取操作记录 |

成果提交正文：

```json
{
  "expectedVersion": 1,
  "title": "第一版成果说明",
  "description": "说明交付内容、数据来源与尚待补充的部分",
  "evidenceUrl": "https://example.com/evidence"
}
```

人工验收正文：

```json
{
  "expectedVersion": 2,
  "submissionVersion": 1,
  "decision": "accept",
  "quality": 85,
  "note": "已实际核对当前成果及约定标准，保留核对依据",
  "verifiedCurrentSubmission": true
}
```

以上版本号仅展示字段关系，实际请求必须使用最新返回值。退回时使用 `decision: "return"` 并填写原因，无需填写质量分。

## 权限与数据规则

- 员工只读取本人任务，新建任务不能指派给其他人；负责人只管理本部门。
- 个人 KR 只在允许的身份范围内显示。创建任务时，服务端再次校验人员、验收人和关联 KR。
- 负责人不能验收自己的成果；只有指定验收人可以确认相应任务。
- 新成果版本会使旧验收退出当前结果，历史记录保留。旧版本审批不能覆盖新提交。
- 验收通过要求人工质量分、意见和已核对当前材料的确认。任务完成不会自动增加 KR 实际值。
- KR 变化需要单独记录实际值、来源和说明；无法计算的归一化进度返回未知值。
- 证据链接仅保存为元数据，不主动访问外部链接，不上传或解析附件。
- 不含薪资数据、自动去留判断、自动人事操作或个人综合绩效评分。
- API 使用参数化 SQL、结构化校验与受限请求大小；默认不开放跨域访问。

## 验证与后续工作

`npm test` 使用 Fastify 注入请求和 PGlite SQL 数据库，覆盖身份、权限、版本冲突、人工验收与 KR 独立性等接口行为。`npm run typecheck` 检查 TypeScript，`npm run build` 生成可运行代码。

设置 `TEST_DATABASE_URL` 可让同一组接口测试连接测试用 PostgreSQL；测试库必须独立于正式业务库。生产 PostgreSQL 适配器仍需在实际服务器完成联调；本地 PGlite 测试不能证明真实 PostgreSQL 部署、备份或恢复已经通过。远程 CI 的结果以对应 Actions 运行记录为准。正式试点还需完成钉钉登录、前后端联调、文件存储与证据解析、模型输出引用校验、通知队列、工作日历、恢复演练和企业权限验收。
