# Mac 本机联调

[English](MAC_LOCAL.en.md)

本配置运行真实 API 和固定版本的前端，使用独立的持久 PGlite 数据目录，用于钉钉与 Grok Bot 联调。正式部署仍使用 PostgreSQL。开发登录、演示数据和工作通知始终关闭。

## 启动与数据

项目与依赖须位于已挂载的 DevSSD。通过 `WORKOS_DEVSSD_VOLUME_UUID` 或私有 `.runtime/mac-integration/volume.uuid` 提供项目批准的卷 UUID；启动器核对挂载身份，并把编译临时文件放到 SSD。需要现有 Node.js 22+ 和本仓库依赖，也可用 `WORKOS_NODE_BIN` 指定 Node 可执行文件。

```sh
npm_config_cache=/Volumes/DevSSD/Caches/npm npm run local:mac
```

默认地址为 `http://127.0.0.1:18767/`，只绑定回环接口。前端读取相邻 `../onelaser-workos` 仓库，各文件必须匹配 `deploy/frontend-revision.txt` 固定的 Git 对象。未跟踪文件、私有配置、运行目录和符号链接不会被发布。

数据与私有配置位于 Git 忽略的 `.runtime/mac-integration/`。程序仅从此目录的 `local.env` 读取集成凭证，不继承其他工作流的环境凭证。目录权限为 0700，配置文件须为 0600。

## 真实集成

建立独立的临时 HTTPS 隧道，转发到本机端口；使用自己的配置、日志和 metrics 端口，保留客服及 Zoho 进程。在私有 `local.env` 中填写核实的 HTTPS 来源及真实钉钉值：

```dotenv
APP_PUBLIC_URL=https://your-verified-tunnel.example
DINGTALK_CLIENT_ID=
DINGTALK_CLIENT_SECRET=
DINGTALK_CORP_ID=
DINGTALK_ALLOWED_DEPARTMENT_IDS=
DINGTALK_MANAGER_USER_IDS=
```

缺少配置时登录保持关闭；不要填虚构 ID 或通过演示身份替代真实联调。用有应用管理/开发权限的钉钉账号，为独立 OneLaserWorkOS 应用保存 `APP_PUBLIC_URL/api/auth/dingtalk/callback`。若平台拒绝保存，应核对管理员权限；页面显示“拥有者”不代表保存成功，须回查实际配置。

真实登录与 Bot OAuth 使用 HTTPS 入口，本机 HTTP 仅用于诊断。HTTPS 配置启用 Secure、HttpOnly Cookie。按 [Bot 接入说明](../docs/integrations/GROK_BOT_SETUP.md)设置精确回调、可选本地 client-ID 映射及独立 Routine。使用虚构成果验证实际身份、引用回传和人工验收，分别记录“配置完整”“授权成功”“真实回传成功”。

## 停止与恢复

前台用 Ctrl+C 正常关闭。状态文件记录本次 API 进程；停止后台实例前，应核对它仍占用专属端口，不使用全局 `pkill node`，也不停其他隧道。单实例锁在打开数据库前生效，正常退出会释放。崩溃留下的 `run.lock` 仅在确认记录的进程已停止后处理，保留整个 `data/` 目录。

Mac 睡眠、关机或隧道停止会使外部回调不可用。临时地址变化后须更新来源、钉钉回调和 Bot 连接；旧 OAuth audience 不再匹配。工具不安装开机启动项、不修改系统睡眠设置、不创建付费托管资源。
