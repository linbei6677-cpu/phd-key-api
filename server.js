// 极简密钥占用记录服务（零依赖 Node.js）
// 实现“一个密钥全局只允许一台设备进入”：谁先用，谁绑定，第二台设备再输即被拒。
//
// 接口：
//   POST /api/use        body {key}  -> 首次占用 {ok:true}，已占用 {ok:false,reason:'used'}
//   GET  /api/used       -> 已用密钥数组（排查用）
//   DELETE /api/use/<key>  header x-admin-token: <ADMIN_TOKEN>  -> 释放某密钥（换设备时用）
//
// 部署：放到任意能跑 Node 的平台（Railway / Render / 自己的 VPS 等），
//       设置环境变量 ADMIN_TOKEN（用于释放密钥），启动 `node server.js`。
//       拿到公网地址后，填入 phd_workspace.html 的 KEY_API_BASE 并重新部署前端。

const http=require('http');
const fs=require('fs');
const path=require('path');

const FILE=path.join(__dirname,'used.json');
let used=new Set();
try{ used=new Set(JSON.parse(fs.readFileSync(FILE,'utf8'))); }catch(e){}

function persist(){
  try{ fs.writeFileSync(FILE, JSON.stringify([...used])); }
  catch(e){ console.error('persist fail:', e.message); }
}

const server=http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,x-admin-token');
  res.setHeader('Access-Control-Allow-Methods','POST,GET,DELETE,OPTIONS');
  if(req.method==='OPTIONS'){ res.writeHead(204); res.end(); return; }

  const send=(code,obj)=>{ res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); };

  // 原子占用
  if(req.method==='POST' && req.url==='/api/use'){
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      let key='';
      try{ key=(JSON.parse(body)||{}).key||''; }catch(e){}
      if(!key) return send(400,{ok:false,reason:'bad'});
      if(used.has(key)) return send(200,{ok:false,reason:'used'});
      used.add(key); persist();
      return send(200,{ok:true});
    });
    return;
  }

  // 列出已用
  if(req.method==='GET' && req.url==='/api/used'){ return send(200,[...used]); }

  // 释放（需 admin token）——换设备 / 误占时用
  if(req.method==='DELETE' && req.url.startsWith('/api/use/')){
    const tk=req.headers['x-admin-token'];
    if(!process.env.ADMIN_TOKEN || tk!==process.env.ADMIN_TOKEN) return send(403,{ok:false});
    const key=decodeURIComponent(req.url.slice('/api/use/'.length));
    used.delete(key); persist();
    return send(200,{ok:true});
  }

  // 健康检查（供平台探活 / 你自己 ping 用）
  if(req.method==='GET' && req.url==='/'){ return send(200,{ok:true,service:'phd-key-api'}); }

  send(404,{ok:false});
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('key-api listening on '+PORT));
