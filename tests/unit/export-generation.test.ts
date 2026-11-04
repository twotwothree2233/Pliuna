import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { generateExport, type ExportInput } from '../../src/runtime/export-generation'
import type { ExportResource } from '../../src/runtime/export-control'
let root:string
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'trellis-export-generator-'));mkdirSync(join(root,'resources'))})
afterEach(()=>rmSync(root,{recursive:true,force:true}))
function resource(body:Buffer,media_type:string):ExportResource{const id=randomUUID();writeFileSync(join(root,'resources',id),body);return{id,storage_key:id,sha256:createHash('sha256').update(body).digest('hex'),byte_length:body.length,media_type,display_name:'synthetic'}}
function input(){const image=resource(Buffer.from('broken image'),'image/png'),bundle=resource(Buffer.from(JSON.stringify({profile:'managed-v1',html:'<section id="lesson">Before<img src="trellis-resource:picture" alt="Synthetic">After</section>',css:'',state:{schema:{type:'object',additionalProperties:false,properties:{}},initial:{},compatibility_version:'v1'},forms:[],behaviors:[],references:[{name:'picture',target:{kind:'resource',id:image.id}}],export:[{id:'learning',category:'learning',source:{type:'element',element_id:'lesson'}}]})),'application/vnd.trellis.bundle+json');return{root,title:'Synthetic',resources:[bundle,image],views:[{bundle_id:bundle.id,resource_ids:[image.id]}],answers:[]} satisfies ExportInput}
it('marks a corrupt fixed image at its original location without regenerating content',()=>{const result=generateExport(input());expect(result.html).toContain('Before');expect(result.html).toContain('After');expect(result.html).toContain('此处图片未导出');expect(result.issues).toEqual(['View 1: IMAGE_OMITTED_RESOURCE_CORRUPT'])})
it('rejects a resource borrowed from another selected history and a corrupt bundle',()=>{const data=input();data.views[0]!.resource_ids=[];expect(()=>generateExport(data)).toThrow('not frozen');data.views[0]!.resource_ids=[data.resources[1]!.id];writeFileSync(join(root,'resources',data.resources[0]!.storage_key),'corrupt');expect(()=>generateExport(data)).toThrow()})
it('does not expose host paths or resource identities in partial output',()=>{const data=input(),result=generateExport(data);expect(result.html).not.toContain(root);for(const r of data.resources)expect(result.html).not.toContain(r.id)})
