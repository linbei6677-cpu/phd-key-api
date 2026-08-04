# phd-key-api —— 密钥单设备占用服务

极简零依赖 Node 服务，实现「一个密钥全局只允许一台设备进入」：
谁先用，谁绑定；第二台设备再输入同一密钥，后端返回 `used` 直接拒绝。

## 接口
- `GET  /`                      健康检查，返回 `{"ok":true}`
- `POST /api/use`   body `{key}` 首次占用 `{ok:true}`，已占用 `{ok:false,reason:"used"}`
- `GET  /api/used`              查看已占用密钥列表（排查用）
- `DELETE /api/use/<key>`  header `x-admin-token: <ADMIN_TOKEN>` 释放某密钥（换设备/误占时用）

CORS 已放开（`*`），前端跨域调用无需额外配置。

## 本地跑
```bash
ADMIN_TOKEN=my-secret node server.js
# 默认端口 3000，可用 PORT=8080 覆盖
```

## 部署（任选其一）

### A. Railway（你提的平台）
1. 在 GitHub 新建仓库（如 `phd-key-api`），把本目录文件传上去
   （`server.js` `package.json` `Procfile` `railway.json`，**不要传 used.json**）。
2. 打开 https://railway.app → 用 GitHub 登录 → New Project → Deploy from GitHub repo → 选该仓库。
3. Railway 自动识别 Node，执行 `npm start`，读取 `PORT` 环境变量。
4. 项目内 Variables 添加 `ADMIN_TOKEN`（值随便一串，记好，换设备释放要用）。
5. 部署完成拿到 URL（形如 `https://xxx.railway.app`）→ 发给搭工作台的人填进 `KEY_API_BASE`。

### B. Render（免费、无需信用卡，备选）
1. 同样先把代码推到 GitHub 仓库。
2. https://render.com → New → Web Service → 连接该仓库。
3. Build Command 留空，Start Command 填 `node server.js`，计划选 Free。
4. Environment 里加 `ADMIN_TOKEN`。
5. Deploy → 拿到 URL 发我。

## 注意
- 平台容器磁盘是**临时性**的：每次重新部署会重置 `used.json`（密钥占用记录清空，
  密钥会变回「可再次使用」）。你是单密钥自用、极少重部署，影响很小；
  若需严格持久，可挂 Railway Volume 或接数据库（进阶，先不管）。
- 换设备时先释放旧占用：
  ```bash
  curl -X DELETE https://你的地址/api/use/KPVEWG8S4883WASD \
       -H "x-admin-token: 你的ADMIN_TOKEN"
  ```
  释放后新设备即可使用该密钥。
