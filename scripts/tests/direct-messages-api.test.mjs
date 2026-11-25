import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
import { DM_MAX_FILE_BYTES, DM_MAX_TOTAL_BYTES, attachmentValidForMessage, mergeDirectMessages } from '../../src/lib/directMessages.ts';

const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222', C='33333333-3333-4333-8333-333333333333';
const bundle = await bundleFile({ entrySource: `export {POST} from '@/app/api/messages/route'; export {GET} from '@/app/api/messages/[id]/attachments/[attachmentId]/route'; export {DELETE} from '@/app/api/messages/[id]/route';`, stubs: {
  'next/server': `export const NextResponse={json:(body,options={})=>new Response(JSON.stringify(body),{status:options.status||200,headers:{...options.headers,'Content-Type':'application/json'}})};`,
  '@/lib/supabaseServer': `export const authFromRequest=async()=>({user:globalThis.__dmUser?{id:globalThis.__dmUser}:null});export const createServiceClient=()=>globalThis.__dmDb;`,
  '@/lib/rateLimit': `export const checkRateLimit=()=>globalThis.__dmRate!==false;`,
  '@/lib/i18n/apiT': `export const apiTranslate=async()=>key=>key;`,
} });
const api = await import(bundle);

function setup() {
  globalThis.__dmUser=A; globalThis.__dmRate=true;
  const state={friends:[{requester_id:A,addressee_id:B,status:'accepted'}],messages:[],objects:new Map(),removed:[], failInsert:false, failUpload:false, legacy:false};
  globalThis.__dmDb={
    from(table){
      const filters=[]; let values; let op='select';
      const q={select(){return this},eq(k,v){filters.push(row=>String(row[k])===String(v));return this},or(filter){
        if(state.legacy && filter.includes('requester_id')) q.schemaError=true;
        return this;
      },insert(v){values=v;op='insert';return this},delete(){op='delete';return this},
      async run(single=false){
        if(q.schemaError)return {data:null,error:{code:'42703'}};
        if(table==='profiles')return {data:{cmdr_name:'Pilot',avatar_url:null},error:null};
        if(op==='insert'){
          if(state.failInsert)return {data:null,error:{message:'DB failure'}};
          const row={id:state.messages.length+1,created_at:'2026-11-25T10:00:00Z',...values};state.messages.push(row);return {data:row,error:null};
        }
        const rows=(state[table]??[]).filter(row=>filters.every(f=>f(row)));
        if(op==='delete') state.messages=state.messages.filter(row=>!rows.includes(row));
        return {data:single?(rows[0]??null):rows,error:null};
      },maybeSingle(){return this.run(true)},single(){return this.run(true)},then(resolve,reject){return this.run().then(resolve,reject)}};return q;
    }, storage:{from(){return {
      async upload(path,bytes,options){if(state.failUpload)return {error:{message:'down'}};state.objects.set(path,new Blob([bytes],{type:options.contentType}));return {error:null}},
      async download(path){return {data:state.objects.get(path),error:null}},
      async remove(paths){paths.forEach(path=>state.objects.delete(path));state.removed.push(...paths);return {error:null}},
    }}}};
  return state;
}
function post({text='hello',peer=B,files=[]}={}){
  const form=new FormData();form.set('content',text);form.set('peerId',peer);files.forEach(file=>form.append('files',file));
  return api.POST(new Request('https://example.test/api/messages',{method:'POST',body:form}));
}
const download = (message, attachmentId=message.attachments[0].id)=>api.GET(new Request('https://example.test/file'),{params:Promise.resolve({id:String(message.id),attachmentId})});

test('send returns the committed message without a realtime event; enforces authentication and friendship',async()=>{
  const state=setup();let result=await post();assert.equal(result.status,200);assert.equal((await result.json()).message.content,'hello');assert.equal(state.messages.length,1);
  globalThis.__dmUser=null;assert.equal((await post()).status,401);
  globalThis.__dmUser=A;assert.equal((await post({peer:C})).status,403);
  state.friends[0].status='pending';assert.equal((await post()).status,403);
  state.friends=[{user_id:A,friend_id:B}];state.legacy=true;assert.equal((await post()).status,200);
  globalThis.__dmRate=false;assert.equal((await post()).status,429);
});

test('private images and files are available only to message participants, not through public storage',async()=>{
  const state=setup();
  const png=new File([new Uint8Array([137,80,78,71,13,10,26,10,0])],'picture.png',{type:'image/png'});
  const result=await post({text:'',files:[png,new File(['private'],'data.txt')]});assert.equal(result.status,200);
  const message=(await result.json()).message;assert.equal(message.attachments.length,2);assert.equal(state.objects.size,2);
  for(const file of message.attachments)assert.ok(attachmentValidForMessage(file,message));
  globalThis.__dmUser=C;assert.equal((await download(message)).status,404);
  globalThis.__dmUser=null;assert.equal((await download(message)).status,401);
  globalThis.__dmUser=B;const image=await download(message);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.match(image.headers.get('cache-control'),/no-store/);
  const text=await download(message,message.attachments[1].id);assert.equal(text.headers.get('content-type'),'application/octet-stream');assert.match(text.headers.get('content-disposition'),/^attachment/);
  assert.equal(await text.text(),'private');
  // Client-writable metadata cannot point to another pair's object, even if an ID is known.
  message.attachments[0].path=`${C}/${B}/${message.attachments[0].id}.png`;
  state.messages[0]=message;assert.equal((await download(message)).status,404);
});

test('validation rejects forbidden types, image spoofing, excess files, empty/oversized content and request bytes',async()=>{
  const state=setup();
  for(const name of ['script.html','vector.svg','program.exe','script.js'])assert.equal((await post({files:[new File(['x'],name)]})).status,415);
  assert.equal((await post({files:[new File(['not a PNG'],'fake.png')]})).status,415);
  assert.equal((await post({files:Array.from({length:6},(_,i)=>new File(['a'],`${i}.txt`))})).status,413);
  assert.equal((await post({text:''})).status,400);assert.equal((await post({text:'x'.repeat(10001)})).status,400);
  assert.equal((await post({files:[new File([new Uint8Array(DM_MAX_FILE_BYTES+1)],'huge.txt')]})).status,413);
  const oversized=new Request('https://example.test/api/messages',{method:'POST',headers:{'content-length':String(DM_MAX_TOTAL_BYTES+1048577)},body:'x'});
  assert.equal((await api.POST(oversized)).status,413);
  assert.equal(state.messages.length,0);assert.equal(state.objects.size,0);
});

test('failed insert rolls back uploaded objects; storage failure cannot create a partial message',async()=>{
  const state=setup();state.failInsert=true;
  assert.equal((await post({files:[new File(['file'],'document.pdf')]})).status,503);
  assert.equal(state.messages.length,0);assert.equal(state.objects.size,0);assert.equal(state.removed.length,1);
  state.failInsert=false;state.failUpload=true;
  assert.equal((await post({files:[new File(['file'],'document.pdf')]})).status,503);assert.equal(state.messages.length,0);
});

test('only sender deletes through API; deleted message attachments become inaccessible',async()=>{
  const state=setup();const message=(await (await post({files:[new File(['secret'],'data.txt')]})).json()).message;
  const remove=()=>api.DELETE(new Request('https://example.test/api/messages/1',{method:'DELETE'}),{params:Promise.resolve({id:'1'})});
  globalThis.__dmUser=B;assert.equal((await remove()).status,404);
  globalThis.__dmUser=A;assert.equal((await remove()).status,200);assert.equal(state.objects.size,0);
  assert.equal((await download(message)).status,404);
});

test('message merge sorts and deduplicates response/realtime string and numeric ids, retaining newest 300',()=>{
  const a={id:1,created_at:'2026-11-25T10:00:00Z'},b={id:2,created_at:'2026-11-25T10:00:01Z'};
  assert.deepEqual(mergeDirectMessages([b,a],[{...b,id:'2'}]).map(x=>String(x.id)),['1','2']);
  const rows=Array.from({length:350},(_,id)=>({...a,id,created_at:new Date(id*1000).toISOString()}));
  const limited=mergeDirectMessages([],rows);assert.equal(limited.length,300);assert.equal(limited[0].id,50);
});
