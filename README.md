# phd-key-api —— 密钥管理后端

极简零依赖 Node 服务，为工作台提供「访问密钥」的实时管理：
- **合法密钥白名单（keys）**：由密钥后台 `admin.html` 实时增删
- **跨设备占用（used）**：一个密钥全局只允许一台设备进入

工作台门控不再把白名单写死在前端源码，而是实时查询本后端——
后台生成 / 删除密钥即时生效，**无需重部署前端**。

## 接口
- `GET  /`                                  健康检查 `{"ok":true,service:"phd-key-api"}`
- `GET  /api/keys?key=<key>`                查某密钥是否合法（门控用，无需 token）：`{ok:true,key,label,expires}` 或 `{ok:false}`
- `GET  /api/keys`                          列出全部合法密钥（需 `x-admin-token`）
- `POST /api/keys`  body `{key,label,expires}`  添加（需 `x-admin-token`）：`{ok:true}` / `{ok:false,reason:"exists"}`
- `DELETE /api/keys/<key>`                  删除合法密钥（需 `x-admin-token`）；同时清其占用
- `POST /api/use`  body `{key}`             占用（门控用）：合法且未占用 `{ok:true,expires}`，已占用 `{ok:false,reason:"used"}`，不在白名单 `{ok:false,reason:"invalid"}`
- `GET  /api/used`                          已占用列表（需 `x-admin-token`）
- `DELETE /api/use/<key>`                   释放占用（需 `x-admin-token`，换设备用）

CORS 已放开（`*`），前端跨域调用无需额外配置。

## 本地跑
```bash
ADMIN_TOKEN=my-secret node server.js
# 默认端口 3000，可用 PORT=8080 覆盖
```

## 部署（任选其一）
### A. Railway
1. GitHub 新建仓库（如 `phd-key-api`），把本目录文件传上去：
   `server.js` `package.json` `Procfile` `railway.json` `README.md` `.gitignore`
   （**不要传 keys.json / used.json**——运行时自动生成，已写进 .gitignore）。
2. railway.app → GitHub 登录 → New Project → Deploy from GitHub repo → 选该仓库。
3. 自动识别 Node，执行 `npm start`，读 `PORT`。
4. Variables 添加 `ADMIN_TOKEN`（记好，后台增删密钥 / 释放占用要用）。
5. 部署完拿 URL → 填进 phd_workspace.html 的 `KEY_API_BASE` 并重新部署前端。

### B. Render（免费、无需信用卡）
1. 代码在 GitHub 仓库（同上）。
2. render.com → New → Web Service → 连接仓库。
3. Build Command 留空，Start Command `node server.js`，计划 Free。
4. Environment 加 `ADMIN_TOKEN`。
5. Deploy → 拿 URL。

## 密钥后台（admin.html）
- 打开 `admin.html`（与工作台同域名 `/admin.html`），用管理员密码登录。
- 填「后端地址」+「后端管理 Token（ADMIN_TOKEN）」→ 保存。
- 点「生成密钥」→ 自动写入本后端白名单 → 线上即时可用。
- 「密钥列表」实时从后端拉取；删除即时生效（线上立即失效）。

## 数据持久化注意（重要）
- `keys.json`（白名单）与 `used.json`（占用）存运行实例磁盘，已写进 `.gitignore`（不进 Git）。
- 平台容器若被重建（重部署 / 实例回收），这两个文件会重置为空：
  - 占用记录清空 → 已占用的密钥变回「可再次使用」（极少重部署，影响小）。
  - **白名单清空 → 所有密钥失效**，需重新在后台生成；或把「永久主密钥」写死在
    `server.js` 的 `DEFAULT_KEYS` 里（重部署不丢）。
- 如需严格持久，可挂 Railway Volume / Render Disk 或接数据库（进阶）。

## 换设备
先释放旧占用：
```bash
curl -X DELETE https://你的地址/api/use/<key> -H "x-admin-token: 你的ADMIN_TOKEN"
```
释放后其他设备即可使用该密钥。
