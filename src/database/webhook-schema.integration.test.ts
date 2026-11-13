import '../test/integration-preload.js';
import { it, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { TestPool } from '../test/db-guard.js';
import { readTestMigrationPlan } from '../test/migration-plan.js';
import { parseWebhookEvent, webhookDeduplicationKey, type WebhookEvent, type WebhookEventType } from '../modules/webhooks/webhook-contract.js';

const pool = new TestPool({ connectionTimeoutMillis: 3000 });
after(async () => { await pool.end(); });
async function transaction(action: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '10s'");
    await client.query('BEGIN');
    await action(client);
  } finally {
    // The guard permits full ROLLBACK in an aborted transaction; never bypass it
    // with raw-client/savepoint recovery to make negative schema tests pass.
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}
async function project(client: PoolClient) {
  const account = randomUUID(), id = randomUUID();
  await client.query('INSERT INTO accounts(id,email) VALUES($1,$2)', [account, `${account}@test.invalid`]);
  await client.query('INSERT INTO projects(id,account_id,name) VALUES($1,$2,$3)', [id, account, 'Webhook schema']);
  return id;
}
async function endpoint(client: PoolClient, projectId: string, slot = 1) {
  const id = randomUUID();
  await client.query(`INSERT INTO webhook_endpoints(id,project_id,url,encrypted_secret,config_version,subscriptions,signing_key_id,active_slot,encryption_key_id)
    VALUES($1,$2,'https://example.com/hook',decode('abcd','hex'),1,ARRAY['asset.ingested'], $3,$4,'schema-fixture')`, [id, projectId, randomUUID(), slot]);
  return id;
}
function event(projectId: string, type: WebhookEventType = 'asset.ingested'): WebhookEvent {
  const asset_id = randomUUID(), job_id = randomUUID();
  const data = {
    'asset.ingested': { asset_id, stage: 'ingestion', status: 'ready' },
    'asset.failed': { asset_id, stage: 'ingestion', status: 'failed', error: { code: 'INGESTION_FAILED' } },
    'rendition.ready': { asset_id, job_id, profile: '720p', status: 'ready', output_id: randomUUID(), version: 1 },
    'rendition.failed': { asset_id, job_id, profile: '720p', status: 'failed', error: { code: 'TRANSCODING_FAILED' } },
  }[type];
  return parseWebhookEvent({ id: randomUUID(), project_id: projectId, type, schema_version: 1,
    created_at: '2026-11-13T10:00:00.000Z', data });
}
async function insertEvent(client: PoolClient, value: WebhookEvent) {
  return client.query(`INSERT INTO webhook_events(id,project_id,event_type,payload,created_at,schema_version,deduplication_key)
    VALUES($1,$2,$3,$4,$5,1,$6) RETURNING payload_bytes`,
  [value.id, value.project_id, value.type, JSON.stringify(value), value.created_at, webhookDeduplicationKey(value)]);
}
async function delivery(client: PoolClient, projectId: string, endpointId: string, eventId: string) {
  const id = randomUUID();
  await client.query('INSERT INTO webhook_deliveries(id,project_id,event_id,endpoint_id,contract_version) VALUES($1,$2,$3,$4,1)',
    [id, projectId, eventId, endpointId]);
  return id;
}
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;

it('003 upgrades nonempty legacy tables without rewriting historical fields or inferring signing readiness', { timeout: 30000 }, async () => {
  await transaction(async client => {
    const schema = 'lumen_test_webhook_upgrade';
    const fixture = (await client.query(`SELECT pg_get_userbyid(n.nspowner)=current_user AS owned,
      NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.pronamespace=n.oid) AS empty
      FROM pg_namespace n WHERE n.nspname=$1`,[schema])).rows[0];
    assert.equal(fixture?.owned,true); assert.equal(fixture?.empty,true);
    await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
    const plan = await readTestMigrationPlan();
    await client.query(plan[0]!.up); await client.query(plan[1]!.up);
    const p = await project(client), endpointId = randomUUID(), eventId = randomUUID(), deliveryId = randomUUID();
    for (let i = 0; i < 7; i++) {
      await client.query('INSERT INTO webhook_endpoints(id,project_id,url,encrypted_secret) VALUES($1,$2,$3,decode(\'aabb\',\'hex\'))',
        [i === 0 ? endpointId : randomUUID(), p, `https://example.com/legacy-${i}`]);
    }
    for (let i = 0; i < 2; i++) await client.query(`INSERT INTO webhook_events(id,project_id,event_type,payload)
      VALUES($1,$2,'legacy.event',$3)`, [i === 0 ? eventId : randomUUID(), p, JSON.stringify({ old: true, note: 'café 日本語' })]);
    await client.query(`INSERT INTO webhook_deliveries(id,project_id,event_id,endpoint_id,status,attempts_count)
      VALUES($1,$2,$3,$4,'delivering',12)`, [deliveryId,p,eventId,endpointId]);
    await client.query(`INSERT INTO webhook_delivery_attempts(delivery_id,attempt_number,error_message)
      VALUES($1,12,'legacy diagnostic')`, [deliveryId]);
    const tables = ['webhook_endpoints','webhook_events','webhook_deliveries','webhook_delivery_attempts'];
    const oldRows = new Map<string, Record<string, unknown>[]>();
    for (const table of tables) oldRows.set(table, (await client.query(`SELECT to_jsonb(t) AS record FROM ${table} t ORDER BY id`)).rows.map(row => row.record));
    await client.query(plan[2]!.up);
    for (const table of tables) {
      const rows = (await client.query(`SELECT to_jsonb(t) AS record FROM ${table} t ORDER BY id`)).rows.map(row => row.record as Record<string, unknown>);
      const before = oldRows.get(table)!;
      assert.equal(rows.length,before.length);
      rows.forEach((row, i) => {
        const original = before[i]!;
        assert.deepEqual(Object.fromEntries(Object.keys(original).map(key => [key,row[key]])),original);
      });
    }
    assert.equal((await client.query(`SELECT count(*) FROM webhook_endpoints WHERE config_version=0 AND enabled
      AND cardinality(subscriptions)=0 AND signing_key_id IS NULL AND previous_encrypted_secret IS NULL AND active_slot IS NULL`)).rows[0].count,'7');
    assert.equal((await client.query('SELECT count(*) FROM webhook_events WHERE schema_version=0 AND payload_bytes IS NULL AND deduplication_key IS NULL')).rows[0].count,'2');
    assert.equal((await client.query('SELECT project_id FROM webhook_delivery_attempts')).rows[0].project_id,p);
    const legacyDelivery=(await client.query('SELECT attempts_count,lease_token FROM webhook_deliveries')).rows[0];
    assert.equal(legacyDelivery.attempts_count,12); assert.equal(legacyDelivery.lease_token,null);
    assert.equal((await client.query(`SELECT count(*) FROM webhook_delivery_attempts a
      JOIN webhook_deliveries d ON (a.project_id,a.delivery_id,a.contract_version)=(d.project_id,d.id,d.contract_version)
      JOIN webhook_events e ON (d.project_id,d.event_id,d.contract_version)=(e.project_id,e.id,e.schema_version)
      JOIN webhook_endpoints w ON (d.project_id,d.endpoint_id,d.contract_version)=(w.project_id,w.id,w.config_version)`)).rows[0].count,'1');
    assert.equal((await client.query('SELECT payload->>\'note\' AS note FROM webhook_events ORDER BY id LIMIT 1')).rows[0].note,'café 日本語');
    assert.equal((await client.query(`SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname=$1 AND NOT c.convalidated`,[schema])).rows[0].count,'0');
  });
});

it('version-1 events store a matching UTF-8 envelope once and allow no-op updates', { timeout: 15000 }, async () => {
  await transaction(async client => {
    const p = await project(client), value = event(p);
    const result = await insertEvent(client,value);
    const bytes = result.rows[0].payload_bytes as Buffer;
    assert.deepEqual(JSON.parse(bytes.toString('utf8')),value);
    const expected = `{"id": "${value.id}", "data": {"stage": "ingestion", "status": "ready", "asset_id": "${value.data.asset_id}"}, "type": "asset.ingested", "created_at": "${value.created_at}", "project_id": "${p}", "schema_version": 1}`;
    assert.ok(bytes.equals(Buffer.from(expected,'utf8')));
    assert.equal(new TextDecoder('utf-8',{ fatal:true }).decode(bytes),expected);
    const reversed = JSON.stringify(Object.fromEntries(Object.entries(value).reverse()));
    const normalized = (await client.query("SELECT convert_to($1::jsonb::text,'UTF8') AS bytes",[reversed])).rows[0].bytes as Buffer;
    assert.ok(bytes.equals(normalized));
    const escaped = JSON.stringify(value).replaceAll('0','\\u0030');
    const normalizedEscapes = (await client.query("SELECT convert_to($1::jsonb::text,'UTF8') AS bytes",[escaped])).rows[0].bytes as Buffer;
    assert.ok(bytes.equals(normalizedEscapes));
    assert.ok(bytes.length <= 65536);
    await client.query("SET LOCAL TIME ZONE 'Asia/Kolkata'");
    await client.query('UPDATE webhook_events SET payload=payload WHERE id=$1',[value.id]);
    const again = (await client.query('SELECT payload_bytes FROM webhook_events WHERE id=$1',[value.id])).rows[0].payload_bytes as Buffer;
    assert.ok(bytes.equals(again));
    assert.equal(JSON.parse(again.toString('utf8')).created_at,'2026-11-13T10:00:00.000Z');
  });
});

for (const field of ['id','project_id','event_type','schema_version','payload','payload_bytes','created_at','deduplication_key'] as const) it(`version-1 event ${field} is immutable`, { timeout: 15000 }, async () => {
  await transaction(async client => {
    const value = event(await project(client)); await insertEvent(client,value);
    const update = { id: 'gen_random_uuid()', project_id: 'gen_random_uuid()', event_type: "'asset.failed'", schema_version: '0',
      payload: "payload || '{\"extra\":true}'::jsonb", payload_bytes: "decode('abcd','hex')",
      created_at: "created_at + INTERVAL '1 second'", deduplication_key: "'changed'" }[field];
    await assert.rejects(client.query(`UPDATE webhook_events SET ${field}=${update} WHERE id=$1`,[value.id]),code('23514'));
  });
});

it('immutability rejects an otherwise contract-valid replacement of payload, logical key, and matching bytes', { timeout: 15000 }, async () => {
  await transaction(async client => {
    const value=event(await project(client)); await insertEvent(client,value);
    await assert.rejects(client.query(`UPDATE webhook_events SET
      payload=jsonb_set(payload,'{data,asset_id}',to_jsonb($2::text)),
      deduplication_key='asset:' || $2::text || ':ingested',
      payload_bytes=convert_to(jsonb_set(payload,'{data,asset_id}',to_jsonb($2::text))::text,'UTF8')
      WHERE id=$1`,[value.id,randomUUID()]),code('23514'));
  });
});

for (const type of ['asset.failed','rendition.ready','rendition.failed'] as const) it(`persists the exact approved ${type} data and envelope`, { timeout: 15000 }, async () => {
  await transaction(async client => {
    const value=event(await project(client),type), result=await insertEvent(client,value);
    const stored=JSON.parse((result.rows[0].payload_bytes as Buffer).toString('utf8'));
    assert.deepEqual(stored,value);
    assert.deepEqual(Object.keys(stored).sort(),['id','type','schema_version','created_at','project_id','data'].sort());
    assert.equal(stored.schema_version,1);
    if(stored.type==='asset.failed'||stored.type==='rendition.failed') {
      assert.equal(stored.data.error.code,stored.type==='asset.failed'?'INGESTION_FAILED':'TRANSCODING_FAILED');
    }
  });
});

for (const invalid of ['unknown-type','null-type','invalid-profile','wrong-public-error','unicode-value'] as const) it(`SQL rejects ${invalid} without relying on the TypeScript parser`, { timeout: 15000 }, async () => {
  await transaction(async client => {
    const value=event(await project(client),invalid==='invalid-profile'?'rendition.ready':invalid==='wrong-public-error'?'asset.failed':'asset.ingested');
    const payload=JSON.parse(JSON.stringify(value));
    if(invalid==='unknown-type') payload.type='asset.ready';
    if(invalid==='null-type') payload.type=null;
    if(invalid==='invalid-profile') payload.data.profile='4k';
    if(invalid==='wrong-public-error') payload.data.error.code='RAW_INTERNAL_DIAGNOSTIC';
    if(invalid==='unicode-value') payload.data.stage='ingestión';
    await assert.rejects(client.query(`INSERT INTO webhook_events(id,project_id,event_type,payload,created_at,schema_version,deduplication_key)
      VALUES($1,$2,$3,$4,$5,1,$6)`,[value.id,value.project_id,invalid==='unknown-type'?'asset.ready':value.type,
      JSON.stringify(payload),value.created_at,webhookDeduplicationKey(value)]),code('23514'));
  });
});

it('logical outcomes deduplicate even when event UUID changes', { timeout: 15000 }, async () => {
  await transaction(async client => {
    const value = event(await project(client)); await insertEvent(client,value);
    await assert.rejects(insertEvent(client,{ ...value,id:randomUUID() }),code('23505'));
  });
});

for (const invalid of ['null-status','extra-secret-field','raw-error','wrong-envelope-project','mismatched-bytes'] as const) it(`version-1 schema rejects ${invalid}`, { timeout: 15000 }, async () => {
  await transaction(async client => {
    const value = event(await project(client));
    const payload: Record<string,unknown> = JSON.parse(JSON.stringify(value));
    if (invalid === 'null-status') (payload.data as Record<string,unknown>).status=null;
    if (invalid === 'extra-secret-field') payload.secret='not-permitted';
    if (invalid === 'raw-error') (payload.data as Record<string,unknown>).error={ message:'not-permitted' };
    if (invalid === 'wrong-envelope-project') payload.project_id=randomUUID();
    await assert.rejects(client.query(`INSERT INTO webhook_events(id,project_id,event_type,payload,created_at,schema_version,deduplication_key,payload_bytes)
      VALUES($1,$2,$3,$4,$5,1,$6,$7)`, [value.id,value.project_id,value.type,JSON.stringify(payload),value.created_at,
      webhookDeduplicationKey(value),invalid === 'mismatched-bytes' ? Buffer.from('{}') : null]),code('23514'));
  });
});

it('slot uniqueness and range bound active version-1 endpoints to five per project', { timeout: 15000 }, async () => {
  await transaction(async client => {
    const p = await project(client);
    for (let slot=1;slot<=5;slot++) await endpoint(client,p,slot);
    assert.equal((await client.query('SELECT count(*) FROM webhook_endpoints WHERE project_id=$1 AND config_version=1 AND enabled',[p])).rows[0].count,'5');
    await assert.rejects(endpoint(client,p,1),code('23505'));
  });
});

for (const invalid of ['slot-null','slot-six','duplicate-subscription','empty-subscription','unknown-subscription','null-subscription',
  'overlap-too-long','partial-overlap','same-key','nonpositive-overlap','infinite-overlap'] as const) it(`endpoint schema rejects ${invalid}`, { timeout: 15000 }, async () => {
  await transaction(async client => {
    const p = await project(client), id = await endpoint(client,p);
    const rotation="previous_encryption_key_id='schema-fixture',previous_signing_key_id=gen_random_uuid(),previous_encrypted_secret=decode('abcd','hex'),rotation_started_at=NOW(),";
    const update = { 'slot-null': 'active_slot=NULL', 'slot-six':'active_slot=6',
      'duplicate-subscription': "subscriptions=ARRAY['asset.ingested','asset.ingested']",
      'empty-subscription':"subscriptions='{}'::text[]", 'unknown-subscription':"subscriptions=ARRAY['asset.ready']",
      'null-subscription':"subscriptions=ARRAY['asset.ingested',NULL]",
      'overlap-too-long':rotation+"previous_secret_valid_until=NOW()+INTERVAL '25 hours'",
      'partial-overlap':'previous_signing_key_id=gen_random_uuid()',
      'same-key':"previous_encryption_key_id='schema-fixture',previous_signing_key_id=signing_key_id,previous_encrypted_secret=decode('abcd','hex'),rotation_started_at=NOW(),previous_secret_valid_until=NOW()+INTERVAL '1 hour'",
      'nonpositive-overlap':rotation+'previous_secret_valid_until=NOW()',
      'infinite-overlap':rotation+"previous_secret_valid_until='infinity'" }[invalid];
    await assert.rejects(client.query(`UPDATE webhook_endpoints SET ${update} WHERE id=$1`,[id]),code('23514'));
  });
});

it('complete rotation metadata supports an exactly 24-hour overlap without implementing encryption', { timeout: 15000 }, async () => {
  await transaction(async client => {
    const id = await endpoint(client,await project(client));
    await client.query(`UPDATE webhook_endpoints SET previous_encryption_key_id='schema-fixture',previous_signing_key_id=$2,previous_encrypted_secret=decode('abcd','hex'),
      rotation_started_at=NOW(),previous_secret_valid_until=NOW()+INTERVAL '24 hours' WHERE id=$1`,[id,randomUUID()]);
    assert.equal((await client.query('SELECT EXTRACT(EPOCH FROM previous_secret_valid_until-rotation_started_at)::int AS seconds FROM webhook_endpoints WHERE id=$1',[id])).rows[0].seconds,86400);
  });
});

it('delivery project/endpoint/event foreign keys reject cross-project destinations', { timeout: 15000 }, async () => {
  await transaction(async client => {
    const a = await project(client), b = await project(client), endpointId = await endpoint(client,b), value = event(a);
    await insertEvent(client,value);
    await assert.rejects(delivery(client,a,endpointId,value.id),code('23503'));
  });
});

it('event/endpoint delivery uniqueness remains enforced', { timeout: 15000 }, async () => {
  await transaction(async client => {
    const p = await project(client), endpointId = await endpoint(client,p), value = event(p);
    await insertEvent(client,value); await delivery(client,p,endpointId,value.id);
    await assert.rejects(delivery(client,p,endpointId,value.id),code('23505'));
  });
});

it('version-1 deliveries cannot target preserved legacy endpoints', { timeout: 15000 }, async () => {
  await transaction(async client => {
    const p = await project(client), id = randomUUID(), value = event(p); await insertEvent(client,value);
    await client.query("INSERT INTO webhook_endpoints(id,project_id,url,encrypted_secret) VALUES($1,$2,'https://example.com/legacy',decode('aabb','hex'))",[id,p]);
    await assert.rejects(delivery(client,p,id,value.id),code('23503'));
  });
});

it('version-1 deliveries reject a legacy event even when endpoint and project match', { timeout: 15000 }, async () => {
  await transaction(async client => {
    const p=await project(client), endpointId=await endpoint(client,p), eventId=randomUUID();
    await client.query("INSERT INTO webhook_events(id,project_id,event_type,payload) VALUES($1,$2,'legacy.event','{}')",[eventId,p]);
    await assert.rejects(delivery(client,p,endpointId,eventId),code('23503'));
  });
});

it('delivery leases and attempt ownership/fences are stored together for version-1 history', { timeout: 15000 }, async () => {
  await transaction(async client => {
    const p = await project(client), endpointId = await endpoint(client,p), value = event(p); await insertEvent(client,value);
    const id = await delivery(client,p,endpointId,value.id), token = randomUUID();
    await client.query("UPDATE webhook_deliveries SET status='delivering',attempts_count=1,lease_owner='schema-test',lease_token=$2,lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1",[id,token]);
    await client.query('INSERT INTO webhook_delivery_attempts(project_id,delivery_id,contract_version,attempt_number,fencing_token) VALUES($1,$2,1,1,$3)',[p,id,token]);
    assert.equal((await client.query('SELECT fencing_token FROM webhook_delivery_attempts WHERE delivery_id=$1',[id])).rows[0].fencing_token,token);
    await assert.rejects(client.query("UPDATE webhook_deliveries SET status='retrying' WHERE id=$1",[id]),code('23514'));
  });
});

it('attempt composite ownership rejects another project even for a valid delivery UUID', { timeout: 15000 }, async () => {
  await transaction(async client => {
    const p = await project(client), other = await project(client), endpointId = await endpoint(client,p), value = event(p); await insertEvent(client,value);
    const id = await delivery(client,p,endpointId,value.id);
    await assert.rejects(client.query('INSERT INTO webhook_delivery_attempts(project_id,delivery_id,contract_version,attempt_number,fencing_token) VALUES($1,$2,1,1,$3)',[other,id,randomUUID()]),code('23503'));
  });
});

for (const invalid of ['missing-owner','infinite-lease','attempt-counter','missing-fence','attempt-number','attempt-version'] as const) it(`delivery/attempt schema rejects ${invalid}`, { timeout: 15000 }, async () => {
  await transaction(async client => {
    const p=await project(client), endpointId=await endpoint(client,p), value=event(p); await insertEvent(client,value);
    const id=await delivery(client,p,endpointId,value.id);
    if(invalid==='missing-owner') await assert.rejects(client.query("UPDATE webhook_deliveries SET status='delivering',lease_token=gen_random_uuid(),lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1",[id]),code('23514'));
    else if(invalid==='infinite-lease') await assert.rejects(client.query("UPDATE webhook_deliveries SET status='delivering',lease_owner='schema-test',lease_token=gen_random_uuid(),lease_expires_at='infinity' WHERE id=$1",[id]),code('23514'));
    else if(invalid==='attempt-counter') await assert.rejects(client.query('UPDATE webhook_deliveries SET attempts_count=9 WHERE id=$1',[id]),code('23514'));
    else await assert.rejects(client.query(`INSERT INTO webhook_delivery_attempts(project_id,delivery_id,contract_version,attempt_number,fencing_token)
      VALUES($1,$2,$3,$4,$5)`,[p,id,invalid==='attempt-version'?0:1,invalid==='attempt-number'?9:1,
      invalid==='missing-fence'||invalid==='attempt-version'?null:randomUUID()]),code(invalid==='attempt-version'?'23503':'23514'));
  });
});

async function observeBlocking(observer: PoolClient, waiter: number, owner: number) {
  const deadline=Date.now()+4000;
  while(Date.now()<deadline) {
    if((await observer.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',[waiter,owner])).rows[0].blocked) return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error('Concurrent slot insert did not reach an observed PostgreSQL lock wait');
}

for (const ownerOutcome of ['COMMIT','ROLLBACK'] as const) it(`concurrent slot claims observe real blocking and owner ${ownerOutcome}`, { timeout: 20000 }, async () => {
  const clients: PoolClient[]=[];
  let p: string|undefined, account: string|undefined, pending: Promise<unknown>|undefined;
  try {
    for(let i=0;i<3;i++) {
      const client=await pool.connect(); clients.push(client);
      await client.query("SET statement_timeout='8s'"); await client.query("SET lock_timeout='6s'");
    }
    const [owner,waiter,observer]=[clients[0]!,clients[1]!,clients[2]!];
    // Committed parent/slots isolate the unique-index conflict from FK visibility waits.
    await observer.query('BEGIN'); p=await project(observer);
    account=(await observer.query('SELECT account_id FROM projects WHERE id=$1',[p])).rows[0].account_id as string;
    for(let slot=1;slot<=4;slot++) await endpoint(observer,p,slot);
    await observer.query('COMMIT');
    const ownerPid=(await owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const waiterPid=(await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await owner.query('BEGIN'); await endpoint(owner,p,5);
    await waiter.query('BEGIN'); pending=endpoint(waiter,p,5);
    const outcome=pending.then(value=>({value}),error=>({error}));
    await observeBlocking(observer,waiterPid,ownerPid);
    assert.equal((await observer.query('SELECT count(*) FROM webhook_endpoints WHERE project_id=$1',[p])).rows[0].count,'4');
    await owner.query(ownerOutcome);
    const result=await outcome;
    if(ownerOutcome==='COMMIT') {
      assert.ok('error' in result && code('23505')(result.error));
      await waiter.query('ROLLBACK');
    } else {
      assert.ok('value' in result);
      await waiter.query('COMMIT');
    }
    assert.equal((await observer.query('SELECT count(*) FROM webhook_endpoints WHERE project_id=$1 AND enabled AND config_version=1',[p])).rows[0].count,'5');
  } finally {
    if(clients[0]) await clients[0].query('ROLLBACK').catch(()=>{});
    await Promise.allSettled([pending]);
    for(const client of clients) await client.query('ROLLBACK').catch(()=>{});
    const observer=clients[2];
    try {
      if(observer && p) await observer.query('DELETE FROM projects WHERE id=$1',[p]);
      if(observer && account) await observer.query('DELETE FROM accounts WHERE id=$1',[account]);
    } finally { for(const client of clients) client.release(); }
  }
});

it('available_at defaults immediately for media events and can persist a future due time', { timeout: 15000 }, async () => {
  await transaction(async client => {
    const id = randomUUID();
    await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'processing_job',$2,'processing_job.created','{}')",[id,randomUUID()]);
    assert.equal((await client.query('SELECT available_at<=clock_timestamp() AS due FROM outbox_events WHERE id=$1',[id])).rows[0].due,true);
    await client.query("UPDATE outbox_events SET available_at=NOW()+INTERVAL '1 hour' WHERE id=$1",[id]);
    assert.equal((await client.query('SELECT available_at>clock_timestamp() AS future FROM outbox_events WHERE id=$1',[id])).rows[0].future,true);
    const index=(await client.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='idx_outbox_available'")).rows[0].indexdef as string;
    assert.ok(index.includes('(available_at, created_at, id)'));
    assert.ok(index.includes('published_at IS NULL'));
  });
});
