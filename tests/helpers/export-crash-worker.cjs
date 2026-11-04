const { createRequire }=require('node:module'), fs=require('node:fs'),path=require('node:path'),req=createRequire(process.cwd()+'/package.json'),DB=req('better-sqlite3');
const [root,phase]=process.argv.slice(2),db=new DB(path.join(root,'export-control.sqlite')),job=JSON.parse(db.prepare('SELECT manifest FROM export_jobs LIMIT 1').get().manifest);
job.phase=phase;db.prepare('UPDATE export_jobs SET phase=?,manifest=?').run(phase,JSON.stringify(job));db.pragma('synchronous=FULL');db.close();process.stdout.write('DURABLE_READY\n');setInterval(()=>{},1000);
