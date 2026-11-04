import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const req=createRequire(import.meta.url),esbuild=createRequire(req.resolve('vite'))('esbuild'),working=mkdtempSync(join(tmpdir(),'trellis-scale-runner-')),executable=join(working,'benchmark.cjs')
try{
 await esbuild.build({entryPoints:['tests/helpers/storage-benchmark.ts'],outfile:executable,bundle:true,platform:'node',format:'cjs',packages:'external',loader:{'.txt':'text','.sql':'text'}})
 for(const scenario of process.argv.slice(2).length?process.argv.slice(2):['baseline','large','control1k','control10k','control100k','replicas','largefile']){
  try{console.log(execFileSync(process.execPath,['--max-old-space-size=1536',executable,scenario],{env:{...process.env,NODE_PATH:join(process.cwd(),'node_modules')},timeout:180000,maxBuffer:1024*1024}).toString().trim())}
  catch{console.log(JSON.stringify({scenario,complete:false,error:'PROCESS_FAILED_OR_180S_LIMIT',metrics_not_inferred:true}))}
 }
}finally{rmSync(working,{recursive:true,force:true})}
