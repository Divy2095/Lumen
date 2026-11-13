import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { WebhookManagementService } from './webhook-management.service.js';
import { WebhookEncryption } from './webhook-security.js';
const projectId = randomUUID(), other = randomUUID();
const target = { database:'lumen', role:'lumen' };
function deferred() { let resolve!:()=>void; const promise=new Promise<void>(r=>{ resolve=r; }); return {promise,resolve}; }
function fixture() {
  const encryption = new WebhookEncryption('a',{ a:randomBytes(32).toString('hex') });
  const state = { rows:new Map<string,any>(), now:new Date('2030-01-01T00:00:00Z'), inactive:false,
    wrongTarget:false, failWrite:false, unknownCommit:false, mismatch:false };
  const calls: { sql:string; values:unknown[]; connection:string }[]=[];
  let tail=Promise.resolve();
  const hooks: { locked?: (name:string)=>Promise<void> }={};
  const service=(connection='one')=> {
    let working:Map<string,any>|undefined, release:(()=>void)|undefined;
    const db={ query:async(sql:string,values:unknown[]=[])=>{
      calls.push({sql,values,connection});
      const reply=(rows:any[]=[],command=sql.split(' ')[0],count=rows.length)=>({ rows,command,rowCount:count });
      if(sql==='BEGIN') return reply();
      if(sql==='COMMIT') { if(working) state.rows=working; working=undefined; release?.(); release=undefined;
        if(state.unknownCommit) throw new Error('private database transport'); return reply(); }
      if(sql==='ROLLBACK') { working=undefined; release?.(); release=undefined; return reply(); }
      if(sql.includes('current_database()')) return reply([{ ...target, session_role:state.wrongTarget?'other':target.role }]);
      if(sql.includes('FROM projects')) {
        if(sql.endsWith('FOR UPDATE')) {
          const wait=tail, next=deferred(); tail=next.promise; await wait; release=next.resolve;
          working=new Map([...state.rows].map(([id,row])=>[id,{...row}])); await hooks.locked?.(connection);
        }
        return reply(values[0]===projectId || values[0]===other ? [{id:values[0],status:state.inactive?'deletion_pending':'active'}]:[]);
      }
      if(sql.includes('clock_timestamp()')) return reply([{ checked_at:state.now }]);
      const rows=working??state.rows;
      if(sql.startsWith('SELECT active_slot')) return reply([...rows.values()].filter(r=>r.project_id===values[0]&&r.enabled));
      if(sql.startsWith('SELECT')&&sql.includes('FROM webhook_endpoints')) {
        const found=[...rows.values()].filter(r=>r.project_id===values[0]&&(values[1]===undefined||r.id===values[1])&&
          (values[1]!==undefined||(r.config_version===1&&r.encryption_key_id)));
        return reply(found.map(r=>({...r,...(state.mismatch?{project_id:other}:{})})));
      }
      if(state.failWrite) throw new Error('private SQL error');
      if(sql.startsWith('INSERT INTO webhook_endpoints')) {
        const [id,p,url,wire,events,signing,slot,encryptionId]=values;
        rows.set(id as string,{id,project_id:p,url,encrypted_secret:wire,subscriptions:events,signing_key_id:signing,active_slot:slot,
          encryption_key_id:encryptionId,config_version:1,enabled:true,previous_signing_key_id:null,previous_encryption_key_id:null,
          previous_encrypted_secret:null,rotation_started_at:null,previous_secret_valid_until:null,created_at:state.now});
        return reply([],undefined,1);
      }
      if(sql.startsWith('UPDATE webhook_endpoints')) {
        const row=rows.get(values[1] as string); if(!row||row.project_id!==values[0]) return reply();
        if(sql.includes('SET enabled=')) Object.assign(row,{enabled:values[2],active_slot:values[3]});
        else if(sql.includes('previous_signing_key_id=signing_key_id')) Object.assign(row,{
          previous_signing_key_id:row.signing_key_id,previous_encrypted_secret:row.encrypted_secret,previous_encryption_key_id:row.encryption_key_id,
          rotation_started_at:values[2],previous_secret_valid_until:values[3],signing_key_id:values[4],encrypted_secret:values[5],encryption_key_id:values[6]});
        else Object.assign(row,{previous_signing_key_id:null,previous_encrypted_secret:null,previous_encryption_key_id:null,rotation_started_at:null,previous_secret_valid_until:null});
        return reply([],undefined,1);
      }
      throw new Error('Unexpected modeled query');
    }} as unknown as Pick<Client,'query'>;
    return new WebhookManagementService(db,target,encryption,['hooks.example.com']);
  };
  return {state,calls,hooks,service,encryption};
}
const input={projectId,url:'https://hooks.example.com/',subscriptions:['asset.ingested']};
it('creates independent hash-free encrypted secrets and exposes only allowlisted metadata',async()=>{
  const f=fixture(),s=f.service(), one=await s.create(input), two=await s.create(input);
  assert.notEqual(one.secret,two.secret); assert.equal(Buffer.from(one.secret,'base64url').length,32);
  const row=f.state.rows.get(one.id);
  assert.ok(f.encryption.decrypt(row.encrypted_secret,'a',{projectId,endpointId:one.id,signingKeyId:one.signingKeyId}).equals(Buffer.from(one.secret,'base64url')));
  const listed=await s.list(projectId); assert.equal(listed.length,2);
  const shown=await s.show({projectId,endpointId:one.id}); assert.equal(shown.id,one.id);
  for(const value of [JSON.stringify(listed),JSON.stringify(shown)]) { assert.ok(!value.includes(one.secret)); assert.ok(!value.includes('encrypted_secret')); assert.ok(!value.includes('ciphertext')); }
  const insert=f.calls.find(c=>c.sql.startsWith('INSERT'))!; assert.ok(!insert.values.includes(one.secret));
});
it('rejects wrong identities, inactive/missing projects, wrong projects and legacy/incomplete endpoints',async()=>{
  const f=fixture(),s=f.service(),created=await s.create(input), selected={projectId,endpointId:created.id};
  await assert.rejects(s.show({...selected,projectId:other}),/WEBHOOK_NOT_FOUND/);
  await assert.rejects(s.show({projectId,endpointId:randomUUID()}),/WEBHOOK_NOT_FOUND/);
  await assert.rejects(s.show({...selected,projectId:randomUUID()}),/PROJECT_NOT_FOUND/);
  await assert.rejects(s.setEnabled({...selected,projectId:other},false),/WEBHOOK_NOT_FOUND/);
  await assert.rejects(s.rotate({...selected,projectId:other}),/WEBHOOK_NOT_FOUND/);
  assert.equal((await s.list(other)).length,0);
  f.state.mismatch=true; await assert.rejects(s.show(selected),/WEBHOOK_IDENTITY_MISMATCH/); f.state.mismatch=false;
  f.state.inactive=true; await assert.rejects(s.create(input),/PROJECT_INACTIVE/); await assert.rejects(s.rotate(selected),/PROJECT_INACTIVE/); f.state.inactive=false;
  f.state.wrongTarget=true; await assert.rejects(s.create(input),/DATABASE_IDENTITY_MISMATCH/); f.state.wrongTarget=false;
  const row=f.state.rows.get(created.id); row.encryption_key_id=null;
  assert.equal((await s.list(projectId)).length,0); await assert.rejects(s.setEnabled(selected,false),/WEBHOOK_UNMANAGED/);
  row.config_version=0; await assert.rejects(s.rotate(selected),/WEBHOOK_UNMANAGED/);
});
it('allocates five slots and supports idempotent disable/enable without changing URL',async()=>{
  const f=fixture(),s=f.service(),ids=[];
  for(let n=0;n<5;n++) ids.push((await s.create(input)).id);
  await assert.rejects(s.create(input),/WEBHOOK_SLOTS_FULL/);
  const selected={projectId,endpointId:ids[0]!};
  await s.setEnabled(selected,false); await s.setEnabled(selected,false);
  assert.equal(f.state.rows.get(ids[0]!).active_slot,null);
  const replacement=await s.create(input); assert.equal(f.state.rows.get(replacement.id).active_slot,1);
  await assert.rejects(s.setEnabled(selected,true),/WEBHOOK_SLOTS_FULL/);
  await s.setEnabled({projectId,endpointId:replacement.id},false);
  await s.setEnabled(selected,true); await s.setEnabled(selected,true);
  assert.equal(f.state.rows.get(ids[0]!).url,input.url);
});
it('rotation preserves independent current/previous credentials, enforces overlap, expiry and explicit retirement',async()=>{
  const f=fixture(),s=f.service(),one=await s.create(input), selected={projectId,endpointId:one.id};
  for(const hours of [0,25,1.5,NaN]) await assert.rejects(s.rotate(selected,hours),/WEBHOOK_OVERLAP_INVALID/);
  const two=await s.rotate(selected,24); assert.notEqual(two.secret,one.secret);
  let row=f.state.rows.get(one.id); assert.equal(row.previous_signing_key_id,one.signingKeyId);
  assert.equal(row.previous_secret_valid_until.getTime()-row.rotation_started_at.getTime(),86400000);
  assert.ok(f.encryption.decrypt(row.previous_encrypted_secret,'a',{projectId,endpointId:one.id,signingKeyId:one.signingKeyId}).equals(Buffer.from(one.secret,'base64url')));
  f.state.now=new Date(two.previousSecretValidUntil.getTime()-1); await assert.rejects(s.rotate(selected),/WEBHOOK_ROTATION_OVERLAP/);
  f.state.now=new Date(two.previousSecretValidUntil); const three=await s.rotate(selected,1);
  assert.equal(three.previousSigningKeyId,two.signingKeyId);
  await s.retirePrevious(selected); await s.retirePrevious(selected); row=f.state.rows.get(one.id);
  assert.equal(row.previous_encrypted_secret,null); assert.equal(row.previous_encryption_key_id,null);
  await s.rotate(selected);
});
it('rolls back failures and never returns a secret on an uncertain COMMIT',async()=>{
  const f=fixture(),s=f.service(); f.state.failWrite=true;
  await assert.rejects(s.create(input),/^ProvisioningError: DATABASE_OPERATION_FAILED$/); assert.equal(f.state.rows.size,0);
  f.state.failWrite=false; f.state.unknownCommit=true;
  await assert.rejects(s.create(input),(error:any)=>{ assert.equal(error.code,'COMMIT_OUTCOME_UNKNOWN'); assert.ok(error.recovery.endpointId); assert.ok(error.recovery.signingKeyId); assert.ok(!('secret' in error)); return true; });
  assert.equal(f.state.rows.size,1); assert.equal(f.calls.filter(c=>c.sql.startsWith('INSERT')).length,2);
});
it('fails closed on tampered ciphertext and wrong external AES configuration',async()=>{
  const f=fixture(),s=f.service(),one=await s.create(input),selected={projectId,endpointId:one.id};
  f.state.rows.get(one.id).encrypted_secret=Buffer.alloc(61);
  await assert.rejects(s.show(selected),/WEBHOOK_DECRYPTION_FAILED/);
  await assert.rejects(s.setEnabled(selected,false),/WEBHOOK_DECRYPTION_FAILED/);
});
it('models project-lock serialization: concurrent rotations create only one replacement during overlap',{timeout:3000},async()=>{
  const f=fixture(),s=f.service(),created=await s.create(input),selected={projectId,endpointId:created.id};
  const locked=deferred(),release=deferred();
  f.hooks.locked=async name=>{if(name==='first'){locked.resolve();await release.promise;}};
  const first=f.service('first').rotate(selected); await locked.promise;
  const second=f.service('second').rotate(selected); release.resolve();
  const outcomes=await Promise.allSettled([first,second]);
  assert.equal(outcomes[0]!.status,'fulfilled'); assert.equal(outcomes[1]!.status,'rejected');
  assert.match((outcomes[1] as PromiseRejectedResult).reason.code,/WEBHOOK_ROTATION_OVERLAP/);
  const lockQueries=f.calls.filter(c=>c.sql.includes('FOR UPDATE'));
  assert.ok(lockQueries.filter(c=>c.sql.includes('FROM projects')).length>=2);
  assert.ok(lockQueries.filter(c=>c.sql.includes('FROM webhook_endpoints')).length>=2);
});

it('failed rotation rolls back and preserves the current credential and overlap metadata',async()=>{
  const f=fixture(),s=f.service(),created=await s.create(input),selected={projectId,endpointId:created.id};
  const original=f.state.rows.get(created.id);f.state.failWrite=true;
  await assert.rejects(s.rotate(selected),/^ProvisioningError: DATABASE_OPERATION_FAILED$/);
  assert.equal(f.state.rows.get(created.id).signing_key_id,original.signing_key_id);
  assert.equal(f.state.rows.get(created.id).previous_signing_key_id,null);
  f.state.failWrite=false;f.state.unknownCommit=true;
  await assert.rejects(s.rotate(selected),(error:any)=>{
    assert.equal(error.code,'COMMIT_OUTCOME_UNKNOWN');assert.equal(error.recovery.endpointId,created.id);
    assert.ok(error.recovery.signingKeyId);assert.ok(!JSON.stringify(error).includes(created.secret));return true;
  });
});
it('validates destination and subscriptions before beginning a write or generating a stored credential',async()=>{
  const f=fixture(),s=f.service();
  for(const invalid of [{...input,url:'http://hooks.example.com/'},{...input,url:'https://not-allowed.example.com/'},
    {...input,subscriptions:[]},{...input,projectId:'bad'}]) await assert.rejects(s.create(invalid));
  assert.equal(f.calls.length,0);assert.equal(f.state.rows.size,0);
});
