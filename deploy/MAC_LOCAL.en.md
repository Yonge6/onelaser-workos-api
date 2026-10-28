# Mac integration

[中文](MAC_LOCAL.md)

This profile runs the real API and pinned frontend with an independent persistent PGlite directory for DingTalk and Grok Bot integration. Production still uses PostgreSQL. Development login, demo seeding and work notifications are always disabled.

## Start and storage

Keep the checkout and dependencies on mounted DevSSD. Provide the project's approved volume UUID through `WORKOS_DEVSSD_VOLUME_UUID` or private `.runtime/mac-integration/volume.uuid`. The launcher verifies this UUID and places compilation temporary files on SSD. Use existing Node.js 22+ and repository dependencies; `WORKOS_NODE_BIN` can select its executable.

```sh
npm_config_cache=/Volumes/DevSSD/Caches/npm npm run local:mac
```

The default URL is `http://127.0.0.1:18767/`, bound only to loopback. Assets come from adjacent `../onelaser-workos` and must match the Git objects pinned by `deploy/frontend-revision.txt`. Untracked files, private configuration, runtime files and symlinks are never published.

Private configuration and data live in Git-ignored `.runtime/mac-integration/`. Integration credentials are read only from its `local.env`, never another workflow's ambient environment. The directory is mode 0700; configuration must be mode 0600.

## Real integrations

Create an independent temporary HTTPS tunnel to the local port, with separate configuration, logs and metrics. Preserve customer-support and Zoho processes. Configure the verified origin and real DingTalk values in private `local.env`:

```dotenv
APP_PUBLIC_URL=https://your-verified-tunnel.example
DINGTALK_CLIENT_ID=
DINGTALK_CLIENT_SECRET=
DINGTALK_CORP_ID=
DINGTALK_ALLOWED_DEPARTMENT_IDS=
DINGTALK_MANAGER_USER_IDS=
```

Missing values keep sign-in disabled. Never use fictional IDs or demo identities for real acceptance. An account with application management/development permission must save `APP_PUBLIC_URL/api/auth/dingtalk/callback` on the independent OneLaserWorkOS app. Resolve any provider permission refusal; an Owner label is not proof of a successful write. Read the configuration back.

Use the HTTPS entry for real sign-in and Bot OAuth; local HTTP is diagnostic only. HTTPS enables Secure, HttpOnly cookies. Follow the [Bot guide](../docs/integrations/GROK_BOT_SETUP.en.md) for exact callbacks, optional pinned client ID and a dedicated Routine. Use fictional work to verify real identity, citations and human acceptance. Record configuration, authorization and actual completion separately.

## Stop and recover

Ctrl+C shuts down a foreground instance. Check the state PID and its owned port before stopping a background instance; never use global `pkill node` or stop another tunnel. An exclusive profile lock is acquired before opening the database and released on normal shutdown. Only handle a stale `run.lock` after verifying its recorded process has stopped. Preserve the entire `data/` directory.

Sleeping or stopping the Mac/tunnel makes callbacks unavailable. A changed temporary hostname requires origin, DingTalk callback and Bot connection updates; old OAuth audiences no longer match. The tool installs no login agent, changes no sleep settings and creates no paid resources.
