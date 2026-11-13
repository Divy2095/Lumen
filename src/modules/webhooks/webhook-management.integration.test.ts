import '../../test/integration-preload.js';
import { it, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Client, PoolClient } from 'pg';
import { TestPool } from '../../test/db-guard.js';
import { ProvisioningService } from '../auth/provisioning.service.js';
import { WebhookManagementService } from './webhook-management.service.js';
import { WebhookEncryption } from './webhook-security.js';
const pool=new TestPool({connectionTimeoutMillis:3000});after(async()=>pool.end());
const target={database:'lumen_test',role:'lumen_test_runner'};
async function fixture(action:(s:WebhookManagementService,c:PoolClient,p:string,e:WebhookEncryption,encoded:string)=>Promise<void>){
  const c=await pool.connect();let project:{id:string;account_id:string}|undefined;
  try{
    await c.query("SET statement_timeout='8s'");await c.query("SET lock_timeout='6s'");
    project=await new ProvisioningService(c,target).createProject({name:'Webhook management integration',email:`${randomUUID()}@test.invalid`});
    const encoded=JSON.stringify({a:randomBytes(32).toString('hex')}),encryption=new WebhookEncryption('a',JSON.parse(encoded));
    await action(new WebhookManagementService(c,target,encryption,['hooks.example.com']),c,project.id,encryption,encoded);
  }finally{
    try{await c.query('ROLLBACK');if(project){await c.query('DELETE FROM projects WHERE id=$1',[project.id]);await c.query('DELETE FROM accounts WHERE id=$1',[project.account_id]);}}finally{c.release();}
  }
}
it('live management stores authenticated ciphertext only, lists safe metadata and enforces project isolation',async()=>{
  await fixture(async(s,c,p,encryption)=>{
    const created=await s.create({projectId:p,url:'https://hooks.example.com:443/lumen',subscriptions:['asset.ingested','rendition.ready']});
    const row=(await c.query('SELECT * FROM webhook_endpoints WHERE project_id=$1 AND id=$2',[p,created.id])).rows[0];
    assert.equal(row.url,'https://hooks.example.com/lumen');assert.equal(row.encryption_key_id,'a');assert.equal(row.encrypted_secret.length,61);
    assert.ok(encryption.decrypt(row.encrypted_secret,'a',{projectId:p,endpointId:created.id,signingKeyId:created.signingKeyId}).equals(Buffer.from(created.secret,'base64url')));
    const metadata=JSON.stringify(await s.list(p));assert.ok(!metadata.includes(created.secret));assert.ok(!metadata.includes('encrypted_secret'));
    const other=await new ProvisioningService(c,target).createProject({name:'Other webhook project',email:`${randomUUID()}@test.invalid`});
    try {
      await assert.rejects(s.show({projectId:other.id,endpointId:created.id}),/WEBHOOK_NOT_FOUND/);
      await assert.rejects(s.rotate({projectId:other.id,endpointId:created.id}),/WEBHOOK_NOT_FOUND/);
      await assert.rejects(s.setEnabled({projectId:other.id,endpointId:created.id},false),/WEBHOOK_NOT_FOUND/);
      assert.equal((await s.list(other.id)).length,0);
    } finally { await c.query('DELETE FROM projects WHERE id=$1',[other.id]); await c.query('DELETE FROM accounts WHERE id=$1',[other.account_id]); }
    await assert.rejects(s.show({projectId:randomUUID(),endpointId:created.id}),/PROJECT_NOT_FOUND/);
    await assert.rejects(s.setEnabled({projectId:randomUUID(),endpointId:created.id},false),/PROJECT_NOT_FOUND/);
    await c.query("UPDATE projects SET status='deletion_pending' WHERE id=$1",[p]);
    await assert.rejects(s.create({projectId:p,url:'https://hooks.example.com/',subscriptions:['asset.ingested']}),/PROJECT_INACTIVE/);
  });
});
it('live staged rotation keeps both encrypted secrets, rejects overlap and retires previous metadata idempotently',async()=>{
  await fixture(async(s,c,p,encryption)=>{
    const created=await s.create({projectId:p,url:'https://hooks.example.com/',subscriptions:['asset.failed']});
    const selected={projectId:p,endpointId:created.id};const replacement=await s.rotate(selected,24);
    const row=(await c.query('SELECT * FROM webhook_endpoints WHERE id=$1',[created.id])).rows[0];
    assert.equal(row.previous_encryption_key_id,'a');assert.equal(row.previous_signing_key_id,created.signingKeyId);
    assert.ok(encryption.decrypt(row.previous_encrypted_secret,'a',{...selected,signingKeyId:created.signingKeyId}).equals(Buffer.from(created.secret,'base64url')));
    assert.ok(encryption.decrypt(row.encrypted_secret,'a',{...selected,signingKeyId:replacement.signingKeyId}).equals(Buffer.from(replacement.secret,'base64url')));
    await assert.rejects(s.rotate(selected),/WEBHOOK_ROTATION_OVERLAP/);
    await s.retirePrevious(selected);await s.retirePrevious(selected);
    assert.equal((await s.show(selected)).previousEncryptionKeyId,null);
    await s.setEnabled(selected,false);await s.setEnabled(selected,false);assert.equal((await s.show(selected)).enabled,false);
    await s.setEnabled(selected,true);assert.equal((await s.show(selected)).enabled,true);
  });
});
it('live rotation can change external AES IDs while retaining decryptability of the previous secret',async()=>{
  await fixture(async(s,c,p,_encryption,encoded)=>{
    const created=await s.create({projectId:p,url:'https://hooks.example.com/',subscriptions:['asset.ingested']});
    const keys={...JSON.parse(encoded),b:randomBytes(32).toString('hex')};
    const second=new WebhookManagementService(c,target,new WebhookEncryption('b',keys),['hooks.example.com']);
    const selected={projectId:p,endpointId:created.id};await second.rotate(selected,1);
    const metadata=await second.show(selected);assert.equal(metadata.encryptionKeyId,'b');assert.equal(metadata.previousEncryptionKeyId,'a');
    const missing=new WebhookManagementService(c,target,new WebhookEncryption('b',{b:keys.b}),['hooks.example.com']);
    await assert.rejects(missing.show(selected),/WEBHOOK_DECRYPTION_FAILED/);
  });
});
it('real webhook CLI lists metadata and refuses redirected writes without producing secrets',async()=>{
  await fixture(async(s,c,p,_e,encoded)=>{
    const created=await s.create({projectId:p,url:'https://hooks.example.com/',subscriptions:['asset.ingested']});
    const env={...process.env,WEBHOOK_ENCRYPTION_KEYS:encoded,WEBHOOK_ENCRYPTION_KEY_ID:'a',WEBHOOK_HOSTNAME_ALLOWLIST:'hooks.example.com'};
    const args=['--database',target.database,'--role',target.role,'--project-id',p];
    const list=spawnSync(process.execPath,['--import','tsx','src/scripts/provision.ts','webhook:list',...args],{env,encoding:'utf8',timeout:10000});
    assert.equal(list.status,0);assert.ok(list.stdout.includes(created.id));assert.ok(!list.stdout.includes(created.secret));assert.ok(!list.stdout.includes('encrypted_secret'));
    const rejected=spawnSync(process.execPath,['--import','tsx','src/scripts/provision.ts','webhook:rotate-secret',...args,'--endpoint-id',created.id],{env,encoding:'utf8',timeout:10000});
    assert.equal(rejected.status,1);assert.match(rejected.stderr,/interactive/);
    assert.equal((await c.query('SELECT signing_key_id FROM webhook_endpoints WHERE id=$1',[created.id])).rows[0].signing_key_id,created.signingKeyId);
  });
});
it('live simultaneous rotations serialize at the project lock and reject the overlapping replacement',{timeout:20000},async()=>{
  await fixture(async(s,c,p,encryption)=>{
    const created=await s.create({projectId:p,url:'https://hooks.example.com/',subscriptions:['asset.ingested']});
    const waiter=await pool.connect();let release!:()=>void,entered!:()=>void;const order:string[]=[];
    const blocked=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
    let one:Promise<unknown>|undefined,two:Promise<unknown>|undefined;
    try{
      await waiter.query("SET statement_timeout='8s'");await waiter.query("SET lock_timeout='6s'");
      const ownerPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const waiterPid=(await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const wrapped={query:async(sql:string,values?:unknown[])=>{
        if(sql.includes('FROM projects')&&sql.endsWith('FOR UPDATE'))order.push('project');
        if(sql.includes('FROM webhook_endpoints')&&sql.endsWith('FOR UPDATE'))order.push('endpoint');
        if(sql.includes('clock_timestamp() AS checked_at'))order.push('database-clock');
        const result=await c.query(sql,values);if(sql.includes('FROM webhook_endpoints')&&sql.endsWith('FOR UPDATE')){entered();await gate;}return result;
      }} as unknown as Pick<Client,'query'>;
      const selected={projectId:p,endpointId:created.id};
      one=new WebhookManagementService(wrapped,target,encryption,['hooks.example.com']).rotate(selected);
      const oneResult=one.then(()=>({ok:true}),error=>({ok:false,error}));
      await Promise.race([blocked,oneResult.then(()=>{throw new Error('Rotation ended before lock coordination');})]);
      two=new WebhookManagementService(waiter,target,encryption,['hooks.example.com']).rotate(selected);
      const twoResult=two.then(()=>({ok:true}),error=>({ok:false,error}));
      const deadline=Date.now()+4000;let observed=false;
      while(Date.now()<deadline){if((await c.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',[waiterPid,ownerPid])).rows[0].blocked){observed=true;break;}await new Promise(r=>setTimeout(r,20));}
      assert.ok(observed);assert.deepEqual(order,['project','endpoint']);release();assert.equal((await oneResult).ok,true);
      assert.deepEqual(order,['project','endpoint','database-clock']);
      const outcome=await twoResult;assert.equal(outcome.ok,false);assert.ok('error'in outcome&&outcome.error.code==='WEBHOOK_ROTATION_OVERLAP');
    }finally{release?.();await Promise.allSettled([one,two]);await waiter.query('ROLLBACK');waiter.release();}
  });
});

it('persisted ciphertext rejects wrong AES keys, missing keys, tampering and each AAD identity',async()=>{
  await fixture(async(s,c,p,encryption)=>{
    const created=await s.create({projectId:p,url:'https://hooks.example.com/',subscriptions:['asset.ingested']});
    const selected={projectId:p,endpointId:created.id},context={...selected,signingKeyId:created.signingKeyId};
    const row=(await c.query('SELECT encrypted_secret FROM webhook_endpoints WHERE project_id=$1 AND id=$2',[p,created.id])).rows[0];
    for(const field of ['projectId','endpointId','signingKeyId']) assert.throws(()=>encryption.decrypt(row.encrypted_secret,'a',{...context,[field]:randomUUID()}),/WEBHOOK_DECRYPTION_FAILED/);
    for(const keys of [{a:randomBytes(32).toString('hex')},{b:randomBytes(32).toString('hex')}]){
      const external=new WebhookEncryption(Object.keys(keys)[0]!,keys);
      await assert.rejects(new WebhookManagementService(c,target,external,['hooks.example.com']).show(selected),/WEBHOOK_DECRYPTION_FAILED/);
    }
    assert.throws(()=>WebhookEncryption.fromEnvironment({}),/WEBHOOK_ENCRYPTION_CONFIG_INVALID/);
    const plain=Buffer.from(created.secret,'base64url');assert.ok(!row.encrypted_secret.includes(plain));
    const metadata=JSON.stringify(await s.show(selected));
    assert.ok(!metadata.includes(created.secret));assert.ok(!metadata.includes(row.encrypted_secret.toString('hex')));
    const changed=Buffer.from(row.encrypted_secret);changed[60]=changed[60]!^1;
    await c.query('UPDATE webhook_endpoints SET encrypted_secret=$3 WHERE project_id=$1 AND id=$2',[p,created.id,changed]);
    await assert.rejects(s.show(selected),/WEBHOOK_DECRYPTION_FAILED/);
    await assert.rejects(s.rotate(selected),/WEBHOOK_DECRYPTION_FAILED/);
  });
});
it('expired overlap can be replaced using database clock and retirement clears previous eligibility',async()=>{
  await fixture(async(s,c,p)=>{
    const created=await s.create({projectId:p,url:'https://hooks.example.com/',subscriptions:['asset.ingested']}),selected={projectId:p,endpointId:created.id};
    const previous=await s.rotate(selected,24);
    await c.query(`UPDATE webhook_endpoints SET rotation_started_at=clock_timestamp()-INTERVAL '2 hours',
      previous_secret_valid_until=clock_timestamp()-INTERVAL '1 hour' WHERE project_id=$1 AND id=$2`,[p,created.id]);
    const before=(await c.query('SELECT clock_timestamp() AS time')).rows[0].time as Date;
    const replacement=await s.rotate(selected,1);
    const after=(await c.query('SELECT clock_timestamp() AS time')).rows[0].time as Date;
    const stored=(await s.show(selected));
    assert.equal(replacement.previousSigningKeyId,previous.signingKeyId);
    assert.ok(stored.rotationStartedAt!.getTime()>=before.getTime()&&stored.rotationStartedAt!.getTime()<=after.getTime());
    assert.equal(stored.previousSecretValidUntil!.getTime()-stored.rotationStartedAt!.getTime(),3600000);
    await assert.rejects(s.rotate(selected,25),/WEBHOOK_OVERLAP_INVALID/);
    await s.retirePrevious(selected);assert.equal((await s.show(selected)).previousSigningKeyId,null);
    await s.rotate(selected,24);assert.equal((await s.show(selected)).previousSecretValidUntil!.getTime()-(await s.show(selected)).rotationStartedAt!.getTime(),86400000);
  });
});
for(const fault of ['post-write','lost-commit'] as const)it(`live ${fault} returns no secret through the CLI and never retries`,async()=>{
  await fixture(async(_s,c,p,encryption)=>{
    const {runWebhookCli}=await import('./webhook-management.cli.js');
    const errors:string[]=[],output:string[]=[];let reveals=0,writes=0;
    const wrapped={query:async(sql:string,values?:unknown[])=>{
      const result=await c.query(sql,values);
      if(sql.startsWith('INSERT INTO webhook_endpoints')){writes++;if(fault==='post-write')throw new Error('private injected failure');}
      if(sql==='COMMIT'&&fault==='lost-commit')throw new Error('private lost COMMIT response');
      return result;
    }} as unknown as Pick<Client,'query'>;
    const service=new WebhookManagementService(wrapped,target,encryption,['hooks.example.com']);
    const code=await runWebhookCli(['webhook:create','--database',target.database,'--role',target.role,'--project-id',p,
      '--url','https://hooks.example.com/','--events','asset.ingested'],{
      interactive:()=>true,write:async text=>{output.push(text);},error:text=>{errors.push(text);},
      question:async()=>`webhook:create ${target.database} ${target.role} ${p}`,reveal:async()=>{reveals++;},
    },async()=>({service,endpoint:{host:'postgres-test',port:5432},close:async()=>{}}));
    assert.equal(code,1);assert.equal(reveals,0);assert.equal(writes,1);
    assert.ok(!errors.join('').includes('private'));assert.ok(!output.join('').includes('encrypted_secret'));
    assert.equal((await c.query('SELECT count(*) FROM webhook_endpoints WHERE project_id=$1',[p])).rows[0].count,fault==='post-write'?'0':'1');
    if(fault==='lost-commit'){assert.ok(errors.join('').includes('Commit outcome unknown'));assert.ok(errors.join('').includes('Recovery IDs'));}
  });
});
it('failed rotation after its SQL update rolls back both current and previous ciphertext',async()=>{
  await fixture(async(s,c,p,encryption)=>{
    const created=await s.create({projectId:p,url:'https://hooks.example.com/',subscriptions:['asset.ingested']}),selected={projectId:p,endpointId:created.id};
    const before=(await c.query('SELECT encrypted_secret FROM webhook_endpoints WHERE id=$1',[created.id])).rows[0].encrypted_secret as Buffer;
    const wrapped={query:async(sql:string,values?:unknown[])=>{const result=await c.query(sql,values);if(sql.startsWith('UPDATE webhook_endpoints'))throw new Error('private post-update failure');return result;}} as unknown as Pick<Client,'query'>;
    await assert.rejects(new WebhookManagementService(wrapped,target,encryption,['hooks.example.com']).rotate(selected),/^ProvisioningError: DATABASE_OPERATION_FAILED$/);
    const after=(await c.query('SELECT encrypted_secret,previous_encrypted_secret,signing_key_id FROM webhook_endpoints WHERE id=$1',[created.id])).rows[0];
    assert.ok(before.equals(after.encrypted_secret));assert.equal(after.previous_encrypted_secret,null);assert.equal(after.signing_key_id,created.signingKeyId);
  });
});
it('concurrent service creations observe a real project lock and cannot exceed five slots',{timeout:20000},async()=>{
  await fixture(async(s,c,p,encryption)=>{
    const input={projectId:p,url:'https://hooks.example.com/',subscriptions:['asset.ingested']};
    for(let n=0;n<4;n++)await s.create(input);
    const waiter=await pool.connect();let release!:()=>void,entered!:()=>void;
    const locked=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
    let one:Promise<unknown>|undefined,two:Promise<unknown>|undefined;
    try{
      await waiter.query("SET statement_timeout='8s'");await waiter.query("SET lock_timeout='6s'");
      const ownerPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const waiterPid=(await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const wrapped={query:async(sql:string,values?:unknown[])=>{const result=await c.query(sql,values);if(sql.includes('FROM projects')&&sql.endsWith('FOR UPDATE')){entered();await gate;}return result;}} as unknown as Pick<Client,'query'>;
      one=new WebhookManagementService(wrapped,target,encryption,['hooks.example.com']).create(input);
      const a=one.then(()=>({ok:true}),error=>({ok:false,error}));
      await Promise.race([locked,a.then(()=>{throw new Error('Create ended before lock coordination');})]);
      two=new WebhookManagementService(waiter,target,encryption,['hooks.example.com']).create(input);
      const b=two.then(()=>({ok:true}),error=>({ok:false,error}));
      const deadline=Date.now()+4000;let blocked=false;
      while(Date.now()<deadline){if((await c.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',[waiterPid,ownerPid])).rows[0].blocked){blocked=true;break;}await new Promise(r=>setTimeout(r,20));}
      assert.ok(blocked);release();assert.equal((await a).ok,true);const outcome=await b;
      assert.equal(outcome.ok,false);assert.ok('error'in outcome&&outcome.error.code==='WEBHOOK_SLOTS_FULL');
      assert.equal((await c.query('SELECT count(*) FROM webhook_endpoints WHERE project_id=$1 AND enabled',[p])).rows[0].count,'5');
    }finally{release?.();await Promise.allSettled([one,two]);await waiter.query('ROLLBACK');waiter.release();}
  });
});
