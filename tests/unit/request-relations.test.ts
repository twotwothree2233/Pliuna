import { expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { requestRelations } from '../../src/runtime/model/request-relations'
const manifest=(id:string,sources:string[])=>({version:1,request_id:id,purpose:'main',stage:null,entries:sources.map((id,message)=>({message,kind:'model.tool_result',representation:'recorded-message',request_type:'write',source:{kind:'event',id}})),originals:[],supplements:[],reviewed_requests:[],run_id:'run'})
it('keeps P1 membership when P2 lacks that source; reads only explicitly linked same-task manifests',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE records(id TEXT,task_id TEXT,kind TEXT,sequence INTEGER,payload_json TEXT)')
 const put=db.prepare('INSERT INTO records VALUES (?,?,?,?,?)');put.run('e1','task','model.request.evidence',1,JSON.stringify(manifest('p1',['source'])));put.run('e2','task','model.request.evidence',2,JSON.stringify(manifest('p2',[])))
 const record=(id:string,sequence:number,evidence_event_id:string,request_id:string,kind='model.tool_result')=>({id,sequence,kind,payload:{run_id:'run',request_link:{evidence_event_id,request_id}}})
 const records=[record('source',3,'e1','p1'),record('answer',4,'e2','p2','message.assistant')],facts=requestRelations(db,'task',records)
 expect(facts).toMatchObject({requests:[{request_link:{request_id:'p1'},matched_input_sources:[{source_id:'source',request_type:'write'}]},{request_link:{request_id:'p2'},matched_input_sources:[]}]})
 expect(facts).toMatchObject({latest_chat_message:{owner_run_id:'run'},responses:[{record_id:'source',owner_run_id:'run'},{record_id:'answer',owner_run_id:'run'}],requests:[{owner_run_id:'run'},{owner_run_id:'run'}]})
 expect(()=>requestRelations(db,'other',records)).toThrow('missing in this task')
 put.run('bad','task','model.request.evidence',1,JSON.stringify(manifest('different',[])))
 expect(()=>requestRelations(db,'task',[record('answer',8,'bad','p1','message.assistant')])).toThrow('mismatch');db.close()
})
it('does not invent legacy request links, and chooses the latest answer by sequence rather than array order',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE records(id TEXT,task_id TEXT,kind TEXT,sequence INTEGER,payload_json TEXT)')
 expect(requestRelations(db,'task',[{id:'new',sequence:8,kind:'message.assistant',payload:{}},{id:'old',sequence:2,kind:'model.response',payload:{}}])).toEqual({latest_chat_message:{record_id:'new',kind:'message.assistant',sequence:8,association:'unrecorded'}});db.close()
})
it('never uses a committed answer or bare response as the previous chat, and only aliases equal bodies with exact request links',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE records(id TEXT,task_id TEXT,kind TEXT,sequence INTEGER,payload_json TEXT)')
 const put=db.prepare('INSERT INTO records VALUES (?,?,?,?,?)');put.run('e','task','model.request.evidence',1,JSON.stringify(manifest('p',[])))
 const request_link={request_id:'p',evidence_event_id:'e'},payload={run_id:'run',request_link}
 const records=[{id:'chat',sequence:5,kind:'message.assistant',payload:{...payload,text:'chat text'}},{id:'response',sequence:4,kind:'model.response',payload:{...payload,message:{role:'assistant',content:'chat text'}}},{id:'answer',sequence:8,kind:'answer.submitted',payload:{answer_id:'business'}}]
 expect(requestRelations(db,'task',records)).toMatchObject({latest_chat_message:{record_id:'chat',kind:'message.assistant',sequence:5,equivalent_response_id:'response',request_link}})
 const response=records.find(record=>'message' in record.payload)
 if(!response || !('message' in response.payload))throw Error('Missing test response')
 response.payload.message.content='different'
 expect(requestRelations(db,'task',records).latest_chat_message).not.toHaveProperty('equivalent_response_id')
 expect(requestRelations(db,'task',records.slice(1))).toEqual({latest_chat_message:null});db.close()
})
it('preserves prior request-local positions and distinguishes database supplements from original input',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE records(id TEXT,task_id TEXT,kind TEXT,sequence INTEGER,payload_json TEXT)')
 const p=manifest('p',['source']);p.entries[0]!.message=8
 const value={...p,supplements:[{source:{kind:'event',id:'source'},representation:'current-database-facts',origin_representation:'historical-preview',target:{kind:'action',id:'action'},observation:{through_sequence:3}}]}
 db.prepare('INSERT INTO records VALUES (?,?,?,?,?)').run('e','task','model.request.evidence',2,JSON.stringify(value))
 const facts=requestRelations(db,'task',[{id:'source',sequence:4,kind:'model.tool_result',payload:{run_id:'run',request_link:{request_id:'p',evidence_event_id:'e'}}}])
 expect(facts.requests).toMatchObject([{request_link:{request_id:'p'},matched_input_sources:[{source_id:'source',message:8,entry_type:'input',request_type:'write'},{source_id:'source',entry_type:'database-supplement',representation:'current-database-facts',origin_representation:'historical-preview'}]}])
 db.close()
})
it('fails closed on corrupted, wrong-Run, future and oversized manifests without rewriting legacy records',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE records(id TEXT,task_id TEXT,kind TEXT,sequence INTEGER,payload_json TEXT)')
 const put=db.prepare('INSERT INTO records VALUES (?,?,?,?,?)'),record={id:'chat',kind:'message.assistant',sequence:5,payload:{run_id:'run',request_link:{request_id:'p',evidence_event_id:'e'}}}
 for(const [sequence,payload] of [[1,'{'],[1,JSON.stringify({...manifest('p',[]),run_id:'other'})],[5,JSON.stringify(manifest('p',[]))],[1,' '.repeat(1048577)]] as const){
  db.exec('DELETE FROM records');put.run('e','task','model.request.evidence',sequence,payload)
  expect(()=>requestRelations(db,'task',[record])).toThrow()
  expect(db.prepare('SELECT payload_json FROM records').get()).toEqual({payload_json:payload})
 }
 db.close()
})
it('anchors historical previous chat to its recorded user trigger, not a later chat or committed answer',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE records(id TEXT,task_id TEXT,kind TEXT,sequence INTEGER,payload_json TEXT)')
 const put=db.prepare('INSERT INTO records VALUES (?,?,?,?,?)'),value=manifest('p',['tool'])
 value.entries.push({message:2,kind:'host-state',representation:'current-state',request_type:'read',source:{kind:'message',id:'user'}})
 put.run('earlier','task','message.assistant',1,'{}');put.run('user','task','message.user',3,JSON.stringify({run_id:'run'}))
 put.run('business','task','answer.submitted',4,'{}');put.run('e','task','model.request.evidence',5,JSON.stringify(value))
 put.run('later','task','message.assistant',7,'{}')
 const record={id:'tool',kind:'model.tool_result',sequence:6,payload:{run_id:'run',request_link:{request_id:'p',evidence_event_id:'e'}}}
 expect(requestRelations(db,'task',[record]).requests?.[0]).toMatchObject({chat_reference:{user_message_id:'user',previous_chat_id:'earlier'}})
 expect(requestRelations(db,'task',[{...record,kind:'message.assistant'}])).toMatchObject({historical_chat_reference:{user_message_id:'user',previous_chat_id:'earlier'}})
 db.prepare("UPDATE records SET payload_json=? WHERE id='user'").run(JSON.stringify({run_id:'wrong'}))
 expect(()=>requestRelations(db,'task',[record])).toThrow('trigger is unavailable')
 db.exec("DELETE FROM records WHERE id='user'")
 expect(()=>requestRelations(db,'task',[record])).toThrow('trigger is unavailable')
 db.close()
})
