/* Synthetic browser-only fixture: no SSH, remote device, local picker or user file access. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const esbuild=require('../desktop-web/node_modules/esbuild');
async function main(){
  const source=path.resolve(process.argv[2]),web=path.resolve(process.argv[3]);if(fs.existsSync(web))throw Error('Choose a fresh fixture directory');fs.cpSync(source,web,{recursive:true});fs.mkdirSync(path.join(web,'tests'));
  await esbuild.build({entryPoints:[path.join(__dirname,'file-browser-test.ts')],outfile:path.join(web,'tests/file-browser-test.js'),bundle:true,format:'esm',platform:'browser'});
  let page=fs.readFileSync(path.join(web,'files.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('<html lang="zh-CN">','<html lang="zh-CN"><base href="/">');
  page=page.replace('</html>','<style>body{display:flex;flex-direction:column}.test-toolbar{box-sizing:border-box;min-height:48px;flex:none;padding:8px 16px;font:12px system-ui;background:#141416;color:#b7bccb}.test-toolbar button{font-size:12px;padding:5px 9px}#file-panel{flex:1;min-height:0;height:auto}#result{max-height:170px;flex:none;overflow:auto;white-space:pre-wrap;font:12px monospace;padding:10px;margin:0;background:#141416}</style><script type="module" src="/tests/file-browser-test.js"></script></html>');
  fs.writeFileSync(path.join(web,'tests/file-browser-entry.html'),page);fs.copyFileSync(path.join(__dirname,'file-browser-small.html'),path.join(web,'tests/file-browser-small.html'));
  const server=http.createServer((req,res)=>{try{const url=new URL(req.url,'http://localhost'),file=path.resolve(web,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(web+path.sep)||!fs.statSync(file).isFile())throw Error('not found');res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream');fs.createReadStream(file).pipe(res);}catch{res.statusCode=404;res.end('fixture asset unavailable');}});
  server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port+'/tests/file-browser-entry.html'));
  process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
