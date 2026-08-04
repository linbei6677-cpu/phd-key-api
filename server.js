// 密钥管理后端（零依赖 Node.js）
// 职责：① 合法密钥白名单（keys）② 跨设备占用记录（used，一密钥一设备）
//
// 接口：
//   GET    /api/keys?key=XXX       查某密钥是否合法（门控用，无需 token）：{ok:true,key,label,expires} 或 {ok:false}
//   GET    /api/keys               列出全部合法密钥（后台管理用，需 x-admin-token）
//   POST   /api/keys               添加合法密钥（需 x-admin-token），body {key,label,expires}
//   DELETE /api/keys/:key          删除合法密钥（需 x-admin-token）
//   POST   /api/use                占用（门控用）：合法且未占用 {ok:true,expires}，已占用 {ok:false,reason:'used'}，不合法 {ok:false,reason:'invalid'}
//   GET    /api/used               已占用列表（需 x-admin-token）
//   DELETE /api/use/:key           释放占用（需 x-admin-token，换设备用）
//   GET    /                       健康检查
//   管理员登录（用户名 + 授权手机号 + 短信验证码，可绑多个手机号）：
//   POST   /api/admin/send-code    发验证码（body {user,phone}），未配置短信服务时回显 code(debug)
//   POST   /api/admin/verify       校验验证码并下发会话令牌（body {phone,code}）-> {ok,token,phones}
//   GET    /api/admin/phones       授权手机号列表（需会话令牌）
//   POST   /api/admin/phones       新增授权手机号（需会话令牌，body {phone}）
//   DELETE /api/admin/phones/:p    移除授权手机号（需会话令牌，至少保留一个）
//
// 部署：连 GitHub 仓库，设环境变量 ADMIN_TOKEN（用于后台增删密钥/释放占用），启动 node server.js。
//       前端 KEY_API_BASE 填本服务地址并重新部署，门控即实时依赖本后端。

const http=require('http');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');

const KEYS_FILE=path.join(__dirname,'keys.json');
const USED_FILE=path.join(__dirname,'used.json');

// 种子白名单：需要“永久有效、重部署不丢”的主密钥可写这里。例：
//   [{key:'XXXX',label:'主密钥',expires:'2099-12-31',created:'2026-08-04'}]
// 留空则所有合法密钥都靠后台实时写入 keys.json（重部署容器重建时会清空，需重新写入）。
const DEFAULT_KEYS=[];

let keys=[];
try{ keys=JSON.parse(fs.readFileSync(KEYS_FILE,'utf8')); }catch(e){ keys=[...DEFAULT_KEYS]; }
let used=new Set();
try{ used=new Set(JSON.parse(fs.readFileSync(USED_FILE,'utf8'))); }catch(e){}

function persistKeys(){ try{ fs.writeFileSync(KEYS_FILE, JSON.stringify(keys,null,2)); }catch(e){ console.error('persistKeys fail:',e.message);} }
function persistUsed(){ try{ fs.writeFileSync(USED_FILE, JSON.stringify([...used])); }catch(e){ console.error('persistUsed fail:',e.message);} }

function findKey(k){ return keys.find(x=>x.key===k); }
function adminOk(req){
  const tk=req.headers['x-admin-token'];
  if(!!process.env.ADMIN_TOKEN && tk===process.env.ADMIN_TOKEN) return true;
  if(tk && sessions[tk] && sessions[tk].exp>Date.now()) return true;
  return false;
}

// ---- 管理员登录：用户名 + 授权手机号 + 短信验证码 ----
const ADMIN_CFG_FILE=path.join(__dirname,'admin.json');
let adminCfg={user:process.env.ADMIN_USER||'admin', phones:(process.env.ADMIN_PHONES||'').split(',').map(s=>s.trim()).filter(Boolean)};
try{ const c=JSON.parse(fs.readFileSync(ADMIN_CFG_FILE,'utf8')); if(c&&typeof c.user==='string') adminCfg=c; }catch(e){}
function persistAdmin(){ try{ fs.writeFileSync(ADMIN_CFG_FILE, JSON.stringify(adminCfg,null,2)); }catch(e){ console.error('persistAdmin fail:',e.message);} }
let smsCodes={}; // phone -> {code, exp}
let sessions={}; // token -> {user, phone, exp}
// 调用阿里云 RPC 接口（短信类），真正解析响应：返回 ok:true 或 ok:false+error(阿里云原文)
async function callAliyun(apiUrl, params){
  const keys=Object.keys(params).sort();
  const q=keys.map(k=>encodeURIComponent(k)+'='+encodeURIComponent(params[k])).join('&');
  const strToSign='GET&'+encodeURIComponent('/')+'&'+encodeURIComponent(q);
  const sig=crypto.createHmac('sha1',process.env.ALIYUN_SK+'&').update(strToSign).digest('base64');
  const url=apiUrl+'?'+q+'&Signature='+encodeURIComponent(sig);
  let resp;
  try{ resp=await fetch(url); }catch(e){ return {ok:false, error:'网络请求异常：'+e.message}; }
  let data={};
  try{ data=await resp.json(); }catch(e){ return {ok:false, error:'响应解析失败（HTTP '+resp.status+'）'}; }
  if(data.Code==='OK'){
    // 部分接口（如 SendSmsVerifyCode）由阿里云生成验证码并通过 Data 返回，优先采用真码
    const d=data.Data||{};
    const realCode=d.Code||d.code||d.VerifyCode||d.verifyCode;
    return {ok:true, code: realCode||undefined};
  }
  return {ok:false, error:(data.Message||data.Code||('HTTP '+resp.status))};
}

async function sendSms(phone,code){
  const p=process.env.SMS_PROVIDER;
  // 1) 阿里云传统短信服务（需自定义签名+模板，企业/有资质用户）
  if(p==='aliyun' && process.env.ALIYUN_AK && process.env.ALIYUN_SK && process.env.ALIYUN_SIGN && process.env.ALIYUN_TPL){
    const params={AccessKeyId:process.env.ALIYUN_AK,Action:'SendSms',Format:'JSON',PhoneNumbers:phone,RegionId:'cn-hangzhou',SignName:process.env.ALIYUN_SIGN,SignatureMethod:'HMAC-SHA1',SignatureNonce:Math.random().toString(36).slice(2),SignatureVersion:'1.0',Timestamp:new Date().toISOString(),TemplateCode:process.env.ALIYUN_TPL,TemplateParam:JSON.stringify({code}),Version:'2017-05-25'};
    return await callAliyun('https://dysmsapi.aliyuncs.com', params);
  }
  // 2) 阿里云号码认证-短信认证（免资质，用平台赠送签名/模板，个人用户推荐）
  if(p==='aliyun-dypns' && process.env.ALIYUN_AK && process.env.ALIYUN_SK && process.env.ALIYUN_DYPNS_SIGN && process.env.ALIYUN_DYPNS_TPL){
    const params={AccessKeyId:process.env.ALIYUN_AK,Action:'SendSmsVerifyCode',Format:'JSON',PhoneNumber:phone,CountryCode:'86',SignName:process.env.ALIYUN_DYPNS_SIGN,SignatureMethod:'HMAC-SHA1',SignatureNonce:Math.random().toString(36).slice(2),SignatureVersion:'1.0',TemplateCode:process.env.ALIYUN_DYPNS_TPL,TemplateParam:JSON.stringify({code}),Timestamp:new Date().toISOString(),Version:'2017-05-25'};
    return await callAliyun('https://dypnsapi.aliyuncs.com', params);
  }
  if(p==='twilio' && process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM){
    try{
      const body=new URLSearchParams({To:phone,From:process.env.TWILIO_FROM,Body:'Your code is '+code+', valid for 5 minutes.'});
      await fetch('https://api.twilio.com/2010-04-01/Accounts/'+process.env.TWILIO_SID+'/Messages.json',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(process.env.TWILIO_SID+':'+process.env.TWILIO_TOKEN).toString('base64')},body:body.toString()});
      return {ok:true};
    }catch(e){ return {ok:false, error:'Twilio 请求失败：'+e.message}; }
  }
  return {ok:true, debug:true, code}; // 未配置短信服务：调试模式（前端明确标注非安全）
}

const server=http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,x-admin-token');
  res.setHeader('Access-Control-Allow-Methods','POST,GET,DELETE,PATCH,OPTIONS');
  if(req.method==='OPTIONS'){ res.writeHead(204); res.end(); return; }

  const send=(code,obj)=>{ res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); };
  const url=req.url.split('?')[0];

  // 查询单密钥是否合法（门控用，无需 token，避免泄露其他密钥）
  if(req.method==='GET' && url==='/api/keys'){
    const q=req.url.split('?')[1]||'';
    const m=q.match(/key=([^&]+)/);
    if(m){
      const k=decodeURIComponent(m[1]);
      const found=findKey(k);
      if(found) return send(200,{ok:true,key:found.key,label:found.label,expires:found.expires});
      return send(200,{ok:false});
    }
    // 无 key 参数 -> 列出全部（后台管理用，需 token）
    if(!adminOk(req)) return send(403,{ok:false});
    return send(200,keys);
  }

  // 添加合法密钥（后台管理用，需 token）
  if(req.method==='POST' && url==='/api/keys'){
    if(!adminOk(req)) return send(403,{ok:false});
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      let o={}; try{ o=JSON.parse(body)||{}; }catch(e){}
      const key=(o.key||'').trim();
      if(!key) return send(400,{ok:false,reason:'bad'});
      if(findKey(key)) return send(200,{ok:false,reason:'exists'});
      const item={key,label:o.label||'密钥',expires:o.expires||'2099-12-31',created:new Date().toISOString().slice(0,10)};
      keys.push(item); persistKeys();
      return send(200,{ok:true,item});
    });
    return;
  }

  // 删除合法密钥（后台管理用，需 token）
  if(req.method==='DELETE' && url.startsWith('/api/keys/')){
    if(!adminOk(req)) return send(403,{ok:false});
    const key=decodeURIComponent(url.slice('/api/keys/'.length));
    const before=keys.length;
    keys=keys.filter(x=>x.key!==key);
    if(keys.length!==before){ persistKeys(); used.delete(key); persistUsed(); }
    return send(200,{ok:true});
  }

  // 更新合法密钥（备注/有效期，后台管理用，需 token）
  if(req.method==='PATCH' && url.startsWith('/api/keys/')){
    if(!adminOk(req)) return send(403,{ok:false});
    const key=decodeURIComponent(url.slice('/api/keys/'.length));
    const found=findKey(key);
    if(!found) return send(404,{ok:false,reason:'notfound'});
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      let o={}; try{ o=JSON.parse(body)||{}; }catch(e){}
      if(typeof o.label==='string') found.label=o.label;
      if(typeof o.expires==='string' && o.expires) found.expires=o.expires;
      persistKeys();
      return send(200,{ok:true,item:found});
    });
    return;
  }

  // 占用（门控用）：先校验白名单，再原子占用
  if(req.method==='POST' && url==='/api/use'){
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      let key=''; try{ key=(JSON.parse(body)||{}).key||''; }catch(e){}
      if(!key) return send(400,{ok:false,reason:'bad'});
      const found=findKey(key);
      if(!found) return send(200,{ok:false,reason:'invalid'});
      if(used.has(key)) return send(200,{ok:false,reason:'used'});
      used.add(key); persistUsed();
      return send(200,{ok:true,expires:found.expires});
    });
    return;
  }

  // 只读校验（门控复核用）：查白名单 + 返回有效期，不触发占用（不影响跨设备占用逻辑）
  if(req.method==='POST' && url==='/api/check'){
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      let key=''; try{ key=(JSON.parse(body)||{}).key||''; }catch(e){}
      if(!key) return send(400,{ok:false,reason:'bad'});
      const found=findKey(key);
      if(!found) return send(200,{ok:false,reason:'invalid'});
      return send(200,{ok:true,expires:found.expires||'2099-12-31'});
    });
    return;
  }

  // 已占用列表（后台管理用，需 token）
  if(req.method==='GET' && url==='/api/used'){
    if(!adminOk(req)) return send(403,{ok:false});
    return send(200,[...used]);
  }

  // 释放占用（后台管理用，需 token，换设备 / 误占时用）
  if(req.method==='DELETE' && url.startsWith('/api/use/')){
    if(!adminOk(req)) return send(403,{ok:false});
    const key=decodeURIComponent(url.slice('/api/use/'.length));
    used.delete(key); persistUsed();
    return send(200,{ok:true});
  }

  // ---- 管理员登录：用户名 + 授权手机号 + 短信验证码 ----
  // 发送验证码（校验用户名与手机号是否已授权）
  if(req.method==='POST' && url==='/api/admin/send-code'){
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',async()=>{
      let o={}; try{ o=JSON.parse(body)||{}; }catch(e){}
      const user=(o.user||'').trim(), phone=(o.phone||'').trim();
      if(user!==adminCfg.user) return send(403,{ok:false,reason:'baduser'});
      if(!/^1\d{10}$/.test(phone)) return send(400,{ok:false,reason:'badphone'});
      if(!adminCfg.phones.includes(phone)) return send(403,{ok:false,reason:'unauth'});
      const code=String(Math.floor(100000+Math.random()*900000));
      const r=await sendSms(phone,code);
      if(!r.ok){ console.error('[SMS] 发送失败 phone='+phone+' error='+r.error); return send(200,{ok:false, reason:'smsfail', detail:r.error}); }
      const finalCode=r.code||code;
      smsCodes[phone]={code:finalCode, exp:Date.now()+5*60*1000};
      return send(200,{ok:true, debug:r.debug, code:r.debug?code:undefined});
    });
    return;
  }
  // 校验验证码并下发会话令牌
  if(req.method==='POST' && url==='/api/admin/verify'){
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      let o={}; try{ o=JSON.parse(body)||{}; }catch(e){}
      const phone=(o.phone||'').trim(), code=(o.code||'').trim();
      const rec=smsCodes[phone];
      if(!rec||rec.code!==code||Date.now()>rec.exp) return send(403,{ok:false,reason:'badcode'});
      delete smsCodes[phone];
      const token=crypto.randomBytes(16).toString('hex');
      sessions[token]={user:adminCfg.user, phone, exp:Date.now()+2*60*60*1000};
      return send(200,{ok:true, token, user:adminCfg.user, phones:adminCfg.phones});
    });
    return;
  }
  // 授权手机号列表（需会话令牌）
  if(req.method==='GET' && url==='/api/admin/phones'){
    if(!adminOk(req)) return send(403,{ok:false});
    return send(200,{ok:true, phones:adminCfg.phones});
  }
  // 新增授权手机号（需会话令牌）
  if(req.method==='POST' && url==='/api/admin/phones'){
    if(!adminOk(req)) return send(403,{ok:false});
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      let o={}; try{ o=JSON.parse(body)||{}; }catch(e){}
      const phone=(o.phone||'').trim();
      if(!/^1\d{10}$/.test(phone)) return send(400,{ok:false,reason:'badphone'});
      if(!adminCfg.phones.includes(phone)){ adminCfg.phones.push(phone); persistAdmin(); }
      return send(200,{ok:true, phones:adminCfg.phones});
    });
    return;
  }
  // 移除授权手机号（需会话令牌，至少保留一个）
  if(req.method==='DELETE' && url.startsWith('/api/admin/phones/')){
    if(!adminOk(req)) return send(403,{ok:false});
    const phone=decodeURIComponent(url.slice('/api/admin/phones/'.length));
    if(adminCfg.phones.length<=1) return send(400,{ok:false,reason:'keepone'});
    adminCfg.phones=adminCfg.phones.filter(p=>p!==phone);
    persistAdmin();
    return send(200,{ok:true, phones:adminCfg.phones});
  }

  // 健康检查
  if(req.method==='GET' && url==='/'){ return send(200,{ok:true,service:'phd-key-api'}); }

  send(404,{ok:false});
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('key-api listening on '+PORT));
