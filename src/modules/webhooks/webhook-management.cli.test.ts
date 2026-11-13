import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ProvisioningError } from '../auth/provisioning.service.js';
import type { ProvisioningIO } from '../auth/provisioning.cli.js';
import { parseWebhookArgs, runWebhookCli, type WebhookSession } from './webhook-management.cli.js';
const projectId=randomUUID(),endpointId=randomUUID(),signingKeyId=randomUUID();
const target=['--database','lumen','--role','lumen','--project-id',projectId];
const create=['webhook:create',...target,'--url','https://hooks.example.com/','--events','asset.ingested'];
const select=(name:string)=>[name,...target,'--endpoint-id',endpointId];
function fixture(args=create) {
  const output:string[]=[],errors:string[]=[],events:string[]=[],revealed:string[]=[];
  const secret=randomBytes(32).toString('base64url');
  const state={terminal:true,answer:'',failReveal:false,failMetadata:false,unknown:false};
  const parsed=parseWebhookArgs(args); state.answer=`${parsed.command} lumen lumen ${projectId}${parsed.endpointId?` ${endpointId}`:''}`;
  const metadata={id:endpointId,projectId,signingKeyId,url:'https://hooks.example.com/',enabled:true,subscriptions:['asset.ingested'],
    encryptionKeyId:'a',previousSigningKeyId:null,previousEncryptionKeyId:null,rotationStartedAt:null,previousSecretValidUntil:null,createdAt:new Date()};
  const committed=async()=>{events.push('mutation');if(state.unknown)throw new ProvisioningError('COMMIT_OUTCOME_UNKNOWN',{projectId,endpointId,signingKeyId});events.push('commit');return {id:endpointId,projectId,signingKeyId,secret};};
  const io:ProvisioningIO={interactive:()=>state.terminal,write:async text=>{if(state.failMetadata&&events.includes('commit'))throw new Error(secret);output.push(text);},
    error:text=>{errors.push(text);},question:async()=>{events.push('confirm');return state.answer;},
    reveal:async value=>{if(state.failReveal)throw new Error(secret);events.push('reveal');revealed.push(value);}};
  const session:WebhookSession={endpoint:{host:'127.0.0.1',port:5432},close:async()=>{events.push('close');},service:{
    verifyTarget:async()=>{events.push('verify');}, getProject:async()=>({id:projectId,account_id:randomUUID(),name:'Example',status:'active'}),
    list:async()=>[metadata], show:async()=>metadata,create:committed,rotate:async()=>({...await committed(),previousSigningKeyId:randomUUID(),previousSecretValidUntil:new Date()}),
    setEnabled:async()=>{events.push('mutation');events.push('commit');return metadata;},retirePrevious:async()=>metadata,
  }};
  const connect=async()=>{events.push('connect');return session;};
  return {io,connect,session,state,events,output,errors,revealed,secret};
}
it('parses all seven commands and rejects missing, duplicate, unknown, unsafe and ambiguous options',()=>{
  assert.equal(parseWebhookArgs(create).command,'webhook:create');
  assert.equal(parseWebhookArgs(['webhook:list',...target]).command,'webhook:list');
  for(const name of ['webhook:show','webhook:enable','webhook:disable','webhook:rotate-secret','webhook:retire-previous-secret']) assert.equal(parseWebhookArgs(select(name)).command,name);
  assert.equal(parseWebhookArgs([...select('webhook:rotate-secret'),'--overlap-hours','1']).hours,1);
  for(const args of [[],['webhook:unknown',...target],['webhook:list'],[...create,'--yes'],
    ['webhook:create',...target,'--url','https://user:password@hooks.example.com/','--events','asset.ingested'],[...create,'--events','asset.ingested'],
    [...select('webhook:show'),'--endpoint-id','bad'],['webhook:show',...target],['webhook:list',...target,'--url','x'],
    [...select('webhook:rotate-secret'),'--overlap-hours','01'],[...select('webhook:rotate-secret'),'--overlap-hours','25'],
    ['webhook:list',...target,'--role','other']]) assert.throws(()=>parseWebhookArgs(args));
});
it('requires exact confirmation, persists, then delivers signing secret only through reveal',async()=>{
  const f=fixture();assert.equal(await runWebhookCli(create,f.io,f.connect),0);
  assert.deepEqual(f.events,['connect','verify','confirm','mutation','commit','reveal','close']);
  assert.deepEqual(f.revealed,[f.secret]); assert.ok(!f.output.join('').includes(f.secret));assert.ok(!f.errors.join('').includes(f.secret));
});
it('rejects redirected input/output before connecting, cancellation and terminal loss before mutation',async()=>{
  const f=fixture();f.state.terminal=false;
  assert.equal(await runWebhookCli(create,f.io,f.connect),1);assert.deepEqual(f.events,[]);
  const cancelled=fixture();cancelled.state.answer='wrong';assert.equal(await runWebhookCli(create,cancelled.io,cancelled.connect),2);assert.ok(!cancelled.events.includes('mutation'));
  const lost=fixture();lost.io.question=async()=>{lost.state.terminal=false;return lost.state.answer;};
  assert.equal(await runWebhookCli(create,lost.io,lost.connect),1);assert.ok(!lost.events.includes('mutation'));
});
it('never reveals secrets on uncertain COMMIT or failed post-commit delivery, and reports recovery IDs',async()=>{
  for(const failure of ['unknown','failReveal','failMetadata'] as const){
    const f=fixture();f.state[failure]=true;
    assert.equal(await runWebhookCli(create,f.io,f.connect),1);assert.equal(f.revealed.length,0);
    assert.ok(f.errors.join('').includes(endpointId)); assert.ok(f.errors.join('').includes(signingKeyId));
    assert.ok(!f.errors.join('').includes(f.secret));assert.ok(!f.output.join('').includes(f.secret));
    assert.equal(f.events.filter(e=>e==='mutation').length,1);
  }
});
it('metadata reads need no terminal; all lifecycle writes require typed confirmation',async()=>{
  for(const args of [['webhook:list',...target],select('webhook:show')]) {
    const f=fixture(args);f.state.terminal=false;assert.equal(await runWebhookCli(args,f.io,f.connect),0);assert.ok(!f.events.includes('confirm'));assert.equal(f.revealed.length,0);
  }
  for(const name of ['webhook:enable','webhook:disable','webhook:rotate-secret','webhook:retire-previous-secret']){
    const args=select(name),f=fixture(args);assert.equal(await runWebhookCli(args,f.io,f.connect),0);assert.ok(f.events.includes('confirm'));
    assert.equal(f.revealed.length,name==='webhook:rotate-secret'?1:0);
  }
});
it('real entrypoint rejects nonterminal writes without database configuration or credential output',()=>{
  const result=spawnSync(process.execPath,['--import','tsx','src/scripts/provision.ts',...create],{
    encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe'],
  });
  assert.equal(result.status,1);assert.match(result.stderr,/interactive stdin and stdout/);assert.doesNotMatch(result.stderr,/PGPASSWORD|postgres:\/\//);
  const help=spawnSync(process.execPath,['--import','tsx','src/scripts/provision.ts','webhook:help'],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});
  assert.equal(help.status,0);assert.match(help.stdout,/webhook:retire-previous-secret/);
});
