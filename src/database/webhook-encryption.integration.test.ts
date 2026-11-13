import '../test/integration-preload.js';
import { it, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { TestPool } from '../test/db-guard.js';
import { readTestMigrationPlan } from '../test/migration-plan.js';
const pool=new TestPool();after(async()=>pool.end());
async function transaction(action:(c:PoolClient)=>Promise<void>){const c=await pool.connect();try{await c.query("SET statement_timeout='10s'");await c.query('BEGIN');await action(c);}finally{try{await c.query('ROLLBACK');}finally{c.release();}}}
async function project(c:PoolClient){const a=randomUUID(),p=randomUUID();await c.query('INSERT INTO accounts(id,email) VALUES($1,$2)',[a,`${a}@test.invalid`]);await c.query("INSERT INTO projects(id,account_id,name) VALUES($1,$2,'Encryption fixture')",[p,a]);return p;}
const errorCode=(code:string)=>(e:any)=>e?.code===code;
async function endpoint(c:PoolClient,p:string,key:string|null='fixture-a'){
  const id=randomUUID();await c.query(`INSERT INTO webhook_endpoints(id,project_id,url,encrypted_secret,config_version,
    subscriptions,signing_key_id,active_slot,encryption_key_id) VALUES($1,$2,'https://example.com/',decode('abcd','hex'),1,
    ARRAY['asset.ingested'],gen_random_uuid(),1,$3)`,[id,p,key]);return id;
}
it('fresh guarded migrations include 001 through 004 and both encryption identifiers',async()=>{
  await transaction(async c=>{
    const names=(await c.query('SELECT name FROM pgmigrations ORDER BY id')).rows.map(r=>r.name);
    assert.deepEqual(names,['001_initial_schema','002_add_transcoding_config','003_webhook_contract','004_webhook_encryption_key_metadata']);
    const columns=(await c.query("SELECT column_name,character_maximum_length FROM information_schema.columns WHERE table_schema='public' AND table_name='webhook_endpoints' AND column_name IN ('encryption_key_id','previous_encryption_key_id') ORDER BY column_name")).rows;
    assert.equal(columns.length,2);assert.ok(columns.every(r=>r.character_maximum_length===64));
  });
});
it('actual 001–003 upgrade preserves legacy and preexisting version-1 ciphertext and leaves identifiers unknown',async()=>{
  await transaction(async c=>{
    const schema='lumen_test_webhook_upgrade';
    const fixture=(await c.query(`SELECT pg_get_userbyid(n.nspowner)=current_user AS owned,
      NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid) AND NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.pronamespace=n.oid) AS empty
      FROM pg_namespace n WHERE n.nspname=$1`,[schema])).rows[0];assert.equal(fixture?.owned,true);assert.equal(fixture?.empty,true);
    await c.query(`SET LOCAL search_path TO "${schema}",pg_catalog`);
    const plan=await readTestMigrationPlan();for(const entry of plan.slice(0,3))await c.query(entry.up);
    const p=await project(c);
    await c.query("INSERT INTO webhook_endpoints(project_id,url,encrypted_secret) VALUES($1,'https://example.com/legacy',decode('aabb','hex'))",[p]);
    const id=randomUUID();await c.query(`INSERT INTO webhook_endpoints(id,project_id,url,encrypted_secret,config_version,subscriptions,
      signing_key_id,active_slot,previous_signing_key_id,previous_encrypted_secret,rotation_started_at,previous_secret_valid_until)
      VALUES($1,$2,'https://example.com/v1',decode('ccdd','hex'),1,ARRAY['asset.ingested'],gen_random_uuid(),1,
      gen_random_uuid(),decode('eeff','hex'),NOW(),NOW()+INTERVAL '24 hours')`,[id,p]);
    const before=(await c.query('SELECT to_jsonb(w) AS row FROM webhook_endpoints w ORDER BY id')).rows.map(r=>r.row);
    await c.query(plan[3]!.up);
    const after=(await c.query('SELECT to_jsonb(w) AS row FROM webhook_endpoints w ORDER BY id')).rows.map(r=>r.row);
    assert.equal(after.length,before.length);
    after.forEach((row,i)=>{assert.equal(row.encryption_key_id,null);assert.equal(row.previous_encryption_key_id,null);
      assert.deepEqual(Object.fromEntries(Object.keys(before[i]).map(k=>[k,row[k]])),before[i]);});
    assert.equal((await c.query('SELECT count(*) FROM webhook_endpoints WHERE config_version=1 AND encryption_key_id IS NOT NULL')).rows[0].count,'0');
    // Version-0 operational updates and no-op historical v1 updates remain valid.
    await c.query('UPDATE webhook_endpoints SET enabled=false WHERE config_version=0');
    assert.equal((await c.query('SELECT enabled FROM webhook_endpoints WHERE config_version=0')).rows[0].enabled,false);
    await c.query('UPDATE webhook_endpoints SET url=url WHERE id=$1',[id]);
    assert.equal((await c.query('SELECT encryption_key_id FROM webhook_endpoints WHERE id=$1',[id])).rows[0].encryption_key_id,null);
    await assert.rejects(c.query('UPDATE webhook_endpoints SET enabled=false,active_slot=NULL WHERE id=$1',[id]),errorCode('23514'));
  });
});
for(const invalid of ['missing-current','invalid-id','previous-only','missing-previous-id','orphan-previous-id','clear-current','change-url'] as const)it(`004 rejects ${invalid}`,async()=>{
  await transaction(async c=>{
    const p=await project(c);
    if(invalid==='missing-current'){await assert.rejects(endpoint(c,p,null),errorCode('23514'));return;}
    if(invalid==='invalid-id'){await assert.rejects(endpoint(c,p,'bad key'),errorCode('23514'));return;}
    const id=await endpoint(c,p);
    const update={ 'previous-only':"encryption_key_id=NULL,previous_encryption_key_id='b'",
      'missing-previous-id':"previous_signing_key_id=gen_random_uuid(),previous_encrypted_secret=decode('abcd','hex'),rotation_started_at=NOW(),previous_secret_valid_until=NOW()+INTERVAL '1 hour'",
      'orphan-previous-id':"previous_encryption_key_id='b'",'clear-current':'encryption_key_id=NULL','change-url':"url='https://other.example.com/'"}[invalid];
    await assert.rejects(c.query(`UPDATE webhook_endpoints SET ${update} WHERE id=$1`,[id]),errorCode('23514'));
  });
});
it('004 permits independent current/previous external keys paired with bounded rotation metadata',async()=>{
  await transaction(async c=>{const p=await project(c),id=await endpoint(c,p);
    await c.query(`UPDATE webhook_endpoints SET previous_signing_key_id=gen_random_uuid(),previous_encryption_key_id='fixture-b',
      previous_encrypted_secret=decode('aabb','hex'),rotation_started_at=NOW(),previous_secret_valid_until=NOW()+INTERVAL '24 hours' WHERE id=$1`,[id]);
    const row=(await c.query('SELECT encryption_key_id,previous_encryption_key_id FROM webhook_endpoints WHERE project_id=$1 AND id=$2',[p,id])).rows[0];
    assert.equal(row.encryption_key_id,'fixture-a');assert.equal(row.previous_encryption_key_id,'fixture-b');
    const other=await project(c);assert.equal((await c.query('SELECT id FROM webhook_endpoints WHERE project_id=$1 AND id=$2',[other,id])).rowCount,0);
  });
});

for(const path of ['insert-select','legacy-upgrade','clear-by-upsert','url-by-upsert','downgrade'] as const)it(`metadata/URL admission cannot be bypassed through ${path}`,async()=>{
  await transaction(async c=>{
    const p=await project(c);
    if(path==='insert-select'){
      await assert.rejects(c.query(`INSERT INTO webhook_endpoints(project_id,url,encrypted_secret,config_version,subscriptions,signing_key_id,active_slot)
        SELECT $1,'https://example.com/',decode('abcd','hex'),1,ARRAY['asset.ingested'],gen_random_uuid(),1`,[p]),errorCode('23514'));return;
    }
    if(path==='legacy-upgrade'){
      const id=randomUUID();await c.query("INSERT INTO webhook_endpoints(id,project_id,url,encrypted_secret) VALUES($1,$2,'https://example.com/legacy',decode('abcd','hex'))",[id,p]);
      await assert.rejects(c.query("UPDATE webhook_endpoints SET config_version=1,subscriptions=ARRAY['asset.ingested'],signing_key_id=gen_random_uuid(),active_slot=1 WHERE id=$1",[id]),errorCode('23514'));return;
    }
    const id=await endpoint(c,p);
    if(path==='downgrade'){
      await assert.rejects(c.query("UPDATE webhook_endpoints SET config_version=0,subscriptions='{}',signing_key_id=NULL,active_slot=NULL,encryption_key_id=NULL WHERE id=$1",[id]),errorCode('23514'));return;
    }
    const update=path==='clear-by-upsert'?'encryption_key_id=NULL':'url=EXCLUDED.url';
    await assert.rejects(c.query(`INSERT INTO webhook_endpoints(id,project_id,url,encrypted_secret,config_version,
      subscriptions,signing_key_id,active_slot,encryption_key_id) VALUES($1,$2,'https://other.example.com/',decode('abcd','hex'),1,
      ARRAY['asset.ingested'],gen_random_uuid(),1,'fixture-a') ON CONFLICT(id) DO UPDATE SET ${update}`,[id,p]),errorCode('23514'));
  });
});
it('encryption key identifiers are bounded by their PostgreSQL type',async()=>{
  await transaction(async c=>{const p=await project(c);await assert.rejects(endpoint(c,p,'a'.repeat(65)),errorCode('22001'));});
});
