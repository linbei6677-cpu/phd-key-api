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
//
// 部署：连 GitHub 仓库，设环境变量 ADMIN_TOKEN（用于后台增删密钥/释放占用），启动 node server.js。
//       前端 KEY_API_BASE 填本服务地址并重新部署，门控即实时依赖本后端。

const http=require('http');
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
function adminOk(req){ const tk=req.headers['x-admin-token']; return !!process.env.ADMIN_TOKEN && tk===process.env.ADMIN_TOKEN; }

const server=http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,x-admin-token');
  res.setHeader('Access-Control-Allow-Methods','POST,GET,DELETE,OPTIONS');
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

  // 健康检查
  if(req.method==='GET' && url==='/'){ return send(200,{ok:true,service:'phd-key-api'}); }

  send(404,{ok:false});
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('key-api listening on '+PORT));
