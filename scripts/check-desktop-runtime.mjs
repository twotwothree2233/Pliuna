import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostMontyTarget } from '../src/shared/native-targets.mjs'
import { verifyDesktop } from './verify-desktop.mjs'

if (process.argv.length !== 3) throw Error('Usage: node scripts/check-desktop-runtime.mjs /absolute/package-output')
const { app, executable } = verifyDesktop(process.argv[2]), target = hostMontyTarget()
const directory = mkdtempSync(join(tmpdir(), 'pliuna-packaged-runtime-'))
try {
  const fixture = join(directory, 'backend.cjs'), probe = join(directory, 'probe.mjs'), pdf = join(directory, 'sample.pdf')
  // A synthetic one-page PDF. No user document or source installation is used.
  const content = 'BT /F1 12 Tf 50 700 Td (Pliuna offline package) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`]
  let body = '%PDF-1.4\n'; const offsets = []
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  writeFileSync(pdf, body)
  writeFileSync(fixture, `
const {spawn} = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {env: process.env, stdio:'ignore'});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{echo:m.params.text,pid:descendant.pid}})+'\\n');
});
`)
  writeFileSync(probe, `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join,dirname,win32} from 'node:path';
import {readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
const root=process.argv[2], require=createRequire(join(root,'package.json'));
const Database=require('better-sqlite3'), db=new Database('probe.sqlite');
db.exec('create table probe(value text)'); db.prepare('insert into probe values (?)').run('包内运行');
assert.equal(db.prepare('select value from probe').get().value,'包内运行');db.close();
let privateAcl=false;
if(process.platform==='win32') {
  const {execFileSync}=await import('node:child_process'),{randomUUID}=await import('node:crypto');
  const {performance}=await import('node:perf_hooks');
  const jobs=require(join(root,'out/main/native/pliuna_job.node'));
  const helper=join(root,'out/main/native/pliuna_acl.exe'),file=join(process.cwd(),'private-acl.txt');
  writeFileSync(file,'package ACL fixture');
  const identity=lstatSync(file,{bigint:true});
  let protectedTime;
  for(let repeat=0;repeat<2;repeat++) {
    const name='Local\\\\Pliuna-'+randomUUID(),owner=jobs.create(name);
    try {
      const deadline=performance.now()+15000;
      const result=JSON.parse(execFileSync(helper,['protect',name,win32.toNamespacedPath(file),String(identity.dev),String(identity.ino),'file','0'],
        {env:process.env,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:4096}));
      assert.deepEqual(result,{version:1,backend:'native',verified:true,changed:repeat===0});
      let waiting;
      while(jobs.active(owner)!==0) {
        const remaining=deadline-performance.now();assert.ok(remaining>0,'Packaged ACL Job exit unconfirmed');
        waiting??=new Int32Array(new SharedArrayBuffer(4));Atomics.wait(waiting,0,0,Math.min(5,remaining));
      }
      assert.ok(performance.now()<=deadline,'Packaged ACL probe exceeded its deadline');
    } finally {try {jobs.terminate(owner)} finally {jobs.close(owner)}}
    const actual=lstatSync(file,{bigint:true});
    assert.equal(actual.dev,identity.dev);assert.equal(actual.ino,identity.ino);
    if(repeat===0)protectedTime=actual.ctimeNs;
    else assert.equal(actual.ctimeNs,protectedTime);
  }
  privateAcl=true;
}
const native=require(join(root,'node_modules',${JSON.stringify(target.package)},${JSON.stringify(target.native)}));
assert.equal(typeof native.NativePool,'function');
const {startProcessTree,processEnvironment,PluginRpc}=await import(pathToFileURL(join(root,'out/main/process-control.js')));
const tree=startProcessTree({mode:'spawn',command:process.execPath,args:[process.argv[3]],cwd:process.cwd(),env:processEnvironment()},{runtime:process.execPath});
let rpc;
try {
  await tree.ready;
  rpc=new PluginRpc(tree.process.stdout,tree.process.stdin,()=>({}));
  const reply=await rpc.request('echo',{text:'包内 app-node'},{timeout:5000});
  assert.equal(reply.echo,'包内 app-node');assert.ok(reply.pid>0);
  tree.terminate();await tree.confirm(10000);
  assert.throws(()=>process.kill(reply.pid,0),{code:'ESRCH'});
} finally {rpc?.close();tree.terminate();await tree.confirm(10000);}
const plugin=join(dirname(root),'reference-plugins/pdf-text');
const pdfTree=startProcessTree({mode:'spawn',command:process.execPath,args:[join(plugin,'backend.mjs')],cwd:plugin,env:processEnvironment()},{runtime:process.execPath});
let pdfRpc;
try {
  await pdfTree.ready;pdfRpc=new PluginRpc(pdfTree.process.stdout,pdfTree.process.stdin,()=>({}));
  const initialized=await pdfRpc.request('initialize',{plugin_id:'pliuna.pdf-text',capabilities:['extract']},{timeout:5000});
  assert.equal(initialized.plugin_id,'pliuna.pdf-text');assert.equal(initialized.protocol_version,'0.1');
  await pdfRpc.request('shutdown',{}, {timeout:5000});
} finally {pdfRpc?.close();pdfTree.terminate();await pdfTree.confirm(10000);}
const bytes=Uint8Array.from(readFileSync(process.argv[4]));
const worker=new Worker(join(plugin,'parser-worker.mjs'),{workerData:{bytes:bytes.buffer},transferList:[bytes.buffer]});
try {
  const parsed=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>{if(code!==0)reject(Error('PDF worker exited: '+code))})});
  assert.equal(parsed.ok,true);assert.equal(parsed.page_count,1);assert.ok(parsed.text.includes('Pliuna offline package'));
} finally {await worker.terminate();}
console.log(JSON.stringify({sqlite:true,montyBinding:true,appNodeRpc:true,descendantsReaped:true,pdfBackend:true,offlinePdf:true,...(privateAcl?{privateAcl:true}:{}),platform:process.platform,arch:process.arch,electron:process.versions.electron}));
`)
  const env = { ELECTRON_RUN_AS_NODE: '1', PATH: '' }
  for (const name of ['SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name]
  execFileSync(executable, [probe, app, fixture, pdf], { cwd: directory, env, timeout: 30000,
    stdio: 'inherit', maxBuffer: 1048576, windowsHide: true })
} finally { rmSync(directory, { recursive: true, force: true }) }
