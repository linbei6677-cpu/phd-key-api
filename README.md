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

### 管理员登录（用户名 + 授权手机号 + 短信验证码，可绑多个手机号）
- `POST /api/admin/send-code`  body `{user,phone}`  发验证码（校验用户名与手机号是否已授权）：`{ok:true,debug,code?}`；未配置短信服务时 `debug:true` 并回显 `code`
- `POST /api/admin/verify`     body `{phone,code}`  校验验证码并下发会话令牌：`{ok:true,token,user,phones}`
- `GET  /api/admin/phones`                         授权手机号列表（需 `x-admin-token` / 会话令牌）
- `POST /api/admin/phones`    body `{phone}`       新增授权手机号（需会话令牌）
- `DELETE /api/admin/phones/<phone>`              移除授权手机号（需会话令牌，至少保留一个）

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
4. Variables 添加：
   - `ADMIN_TOKEN`（记好，后台增删密钥 / 释放占用用，也作为会话令牌的后备）
   - `ADMIN_USER`（管理员用户名，如 `admin`）
   - `ADMIN_PHONES`（授权手机号，逗号分隔可填多个，如 `13800000001,13900000002`；短信登录仅这些号码可用）
   - 可选 `SMS_PROVIDER` + 对应密钥（接真实短信；不配置则进入调试模式，验证码在前端回显，**非安全，仅供本地/测试**。详见下方「短信验证码配置」）
5. 部署完拿 URL → 填进 phd_workspace.html 的 `KEY_API_BASE` 并重新部署前端。

### B. Render（免费、无需信用卡）
1. 代码在 GitHub 仓库（同上）。
2. render.com → New → Web Service → 连接仓库。
3. Build Command 留空，Start Command `node server.js`，计划 Free。
4. Environment 加 `ADMIN_TOKEN`、`ADMIN_USER`、`ADMIN_PHONES`（说明同上）。
5. Deploy → 拿 URL。

## 密钥后台（admin.html）
- 打开 `admin.html`（与工作台同域名 `/admin.html`）。
- 先填「后端地址」，再用 **用户名 + 授权手机号 + 短信验证码** 登录（验证码由后端下发；未接短信服务时在本页回显，仅调试用）。
- 登录后自动获得会话令牌，可管理密钥；无需再手填 ADMIN_TOKEN（该变量仅作后备）。
- 「授权手机号」卡片可增删多个手机号，任一均可登录；至少保留一个。
- 点「生成密钥」→ 自动写入本后端白名单 → 线上即时可用。
- 「密钥列表」实时从后端拉取；删除即时生效（线上立即失效）。

## 短信验证码配置（管理员登录用）
`SMS_PROVIDER` 决定用哪家短信通道。不配置则进入调试模式：验证码在 `admin.html` 页面回显，**非安全，仅供本地/测试**。

### 阿里云号码认证-短信认证（免资质，个人推荐）
阿里云已不允许个人申请普通短信签名。个人用户可走「号码认证服务 → 短信认证」，使用平台赠送的签名和模板，无需资质。

Render/Railway 需加：
- `SMS_PROVIDER` = `aliyun-dypns`
- `ALIYUN_AK` = 你的 AccessKeyId
- `ALIYUN_SK` = 你的 AccessKeySecret
- `ALIYUN_DYPNS_SIGN` = 控制台「短信认证参数配置 → 赠送签名」里选的签名名称
- `ALIYUN_DYPNS_TPL` = 控制台「短信认证参数配置 → 赠送模板」里的 TemplateCode（如 `100001`）

RAM 子账号需授权：`dypns:SendSmsVerifyCode`。

### 阿里云传统短信服务（需资质/企业）
- `SMS_PROVIDER` = `aliyun`
- `ALIYUN_AK` / `ALIYUN_SK`
- `ALIYUN_SIGN` = 你审核通过的自定义签名
- `ALIYUN_TPL` = 你审核通过的模板 CODE（模板内容需含 `${code}`）
- RAM 权限：`dysms:SendSms`

### Twilio（海外场景）
- `SMS_PROVIDER` = `twilio`
- `TWILIO_SID` / `TWILIO_TOKEN` / `TWILIO_FROM`
- 往国内手机发通常失败，不推荐。

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
