#!/usr/bin/env python3
"""Host-only, bounded PTY verification. Requires an authorized, preflighted disposable project.
Terminal transcripts and generated signing/AES secrets stay in memory and are never printed.
Python's standard-library PTY support avoids adding a Node native dependency.
"""
import argparse
import base64
import errno
import json
import os
from pathlib import Path
import pty
import re
import secrets
import select
import signal
import subprocess
import sys
import time
import uuid

checks = 0

def check(condition, message):
    global checks
    checks += 1
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True)
    parser.add_argument('--env-file', required=True)
    args = parser.parse_args()
    check(bool(re.fullmatch(r'lumen-it37-2b-[0-9a-f]{12}', args.project)), 'Invalid disposable project identity')
    root = Path(__file__).resolve().parents[2]
    os.chdir(root)
    envpath = Path(args.env_file).resolve()
    check(envpath.parent == root and envpath.name == '.env.integration.' + args.project, 'Unexpected credential-file location')
    check(envpath.stat().st_mode & 0o777 == 0o600, 'Credential-file permissions are unsafe')
    check(subprocess.run(['git','check-ignore','-q',str(envpath)]).returncode == 0, 'Credential file must be ignored')
    docker = ['docker','--context','rootless']
    compose = docker + ['compose','--project-name',args.project,'--env-file',str(envpath),'-f','compose.test.yaml']
    env = dict(os.environ, LUMEN_ALLOW_DESTRUCTIVE_TESTS='1', WEBHOOK_HOSTNAME_ALLOWLIST='hooks.example.com',
               WEBHOOK_ENCRYPTION_KEY_ID='pty-a', WEBHOOK_ENCRYPTION_KEYS=json.dumps({'pty-a':secrets.token_hex(32)}),
               LUMEN_PTY_PROJECT_ID=str(uuid.uuid4()), LUMEN_PTY_ACCOUNT_ID=str(uuid.uuid4()))
    test_values = dict(line.split('=',1) for line in envpath.read_text().splitlines())
    check(set(test_values) == {'LUMEN_TEST_ADMIN_PASSWORD','LUMEN_TEST_DB_PASSWORD','LUMEN_TEST_REDIS_PASSWORD','LUMEN_TEST_DISPOSABLE_TOKEN'} and
          all(re.fullmatch(r'[0-9a-f]{64}', value) for value in test_values.values()), 'Malformed disposable credentials')
    env.update(test_values)  # Never inherit another run's test credentials from the host.
    forwarded = ['WEBHOOK_HOSTNAME_ALLOWLIST','WEBHOOK_ENCRYPTION_KEY_ID','WEBHOOK_ENCRYPTION_KEYS',
                 'LUMEN_PTY_PROJECT_ID','LUMEN_PTY_ACCOUNT_ID','LUMEN_PTY_EXPECTED_SECRET','LUMEN_PTY_ENDPOINT_ID']
    run_names = []
    def capture(command, **options):
        result = subprocess.run(command, env=env, capture_output=True, timeout=30, **options)
        check(result.returncode == 0, 'Disposable helper failed (output suppressed)')
        return result.stdout
    cfg = json.loads(capture(compose + ['config','--format','json']))
    check(cfg['name'] == args.project and cfg['networks']['isolated-test']['internal'] and not cfg.get('volumes'), 'Unsafe network or volumes')
    for name, service in cfg['services'].items():
        check(not service.get('ports') and not service.get('container_name') and set(service['networks']) == {'isolated-test'}, 'Unsafe service exposure')
        mounts = service.get('volumes', [])
        check(not mounts or (name == 'postgres-test' and len(mounts) == 1 and mounts[0]['read_only'] and Path(mounts[0]['source']) == root/'infra/test/init-postgres.sh'), 'Unsafe bind mount')
    pg = cfg['services']['test-runner']['environment']
    check((pg['PGHOST'],pg['PGDATABASE'],pg['PGUSER'],pg['REDIS_HOST'],pg['STORAGE_BASE_DIR']) ==
          ('postgres-test','lumen_test','lumen_test_runner','redis-test','/lumen-test-storage/runtime'), 'Unsafe configured target')
    ids = capture(docker + ['ps','-aq','--filter','label=com.docker.compose.project='+args.project]).decode().split()
    check(len(ids) == 2, 'Expected exactly two disposable services')
    for container in json.loads(capture(docker + ['inspect',*ids])):
        check(container['Config']['Labels'].get('com.docker.compose.project') == args.project and not container['HostConfig'].get('PortBindings'), 'Unsafe container identity')
        check(len(container['NetworkSettings']['Networks']) == 1, 'Unexpected runtime network')
        for network_name in container['NetworkSettings']['Networks']:
            network=json.loads(capture(docker+['network','inspect',network_name]))[0]
            check(network['Internal'] and network['Labels'].get('com.docker.compose.project') == args.project, 'Unsafe runtime network')
        for mount in container['Mounts']:
            check(mount['Type'] != 'volume' and (mount['Type'] != 'bind' or (not mount['RW'] and Path(mount['Source']) == root/'infra/test/init-postgres.sh')), 'Unsafe runtime mount')
    capture(compose + ['run','--rm','--no-deps','-T','test-runner','npm','run','test:integration:check'])
    def prefix(terminal=False):
        name = args.project+'-pty-'+secrets.token_hex(5)
        run_names.append(name)
        command = compose + ['run','--rm','--no-deps','--name',name]
        if not terminal:
            command.append('-T')
        for name in forwarded:
            if name in env:
                command += ['-e',name]  # Values travel only in the subprocess environment.
        return command + ['test-runner','node','--import','tsx','--import','./src/test/integration-preload.ts']
    def helper(action):
        code = """import {TestPool} from './src/test/db-guard.ts';
import {WebhookEncryption} from './src/modules/webhooks/webhook-security.ts';
const pool=new TestPool();const c=await pool.connect();const p=process.env.LUMEN_PTY_PROJECT_ID,a=process.env.LUMEN_PTY_ACCOUNT_ID;
try {
"""
        if action == 'setup':
            code += "await c.query('BEGIN');await c.query('INSERT INTO accounts(id,email) VALUES($1,$2)',[a,a+'@test.invalid']);await c.query(\"INSERT INTO projects(id,account_id,name) VALUES($1,$2,'PTY verification')\",[p,a]);await c.query('COMMIT');console.log('{}');"
        elif action == 'cleanup':
            code += "await c.query('DELETE FROM projects WHERE id=$1',[p]);await c.query('DELETE FROM accounts WHERE id=$1',[a]);console.log('{}');"
        else:
            code += """const rows=(await c.query('SELECT * FROM webhook_endpoints WHERE project_id=$1 ORDER BY id',[p])).rows;
const selected=rows.find(r=>r.id===process.env.LUMEN_PTY_ENDPOINT_ID);let matches=false;
if(selected&&process.env.LUMEN_PTY_EXPECTED_SECRET){const plain=WebhookEncryption.fromEnvironment(process.env).decrypt(selected.encrypted_secret,selected.encryption_key_id,{projectId:p,endpointId:selected.id,signingKeyId:selected.signing_key_id});matches=plain.equals(Buffer.from(process.env.LUMEN_PTY_EXPECTED_SECRET,'base64url'));plain.fill(0);}
console.log(JSON.stringify({count:rows.length,rows:rows.map(r=>({id:r.id,signingKeyId:r.signing_key_id,enabled:r.enabled,previous:r.previous_signing_key_id})),matches}));"""
        code += "\n}finally{await c.query('ROLLBACK');c.release();await pool.end();}"
        raw = capture(prefix() + ['--input-type=module','-e',code])
        return json.loads(raw.decode().strip().splitlines()[-1])
    secret_pattern = re.compile(rb'Webhook signing secret \(shown once\): ([A-Za-z0-9_-]{43})')
    all_secrets = []
    def cli(command, endpoint=None, expected=0, confirm=True, terminal=True, extra=None, role='lumen_test_runner'):
        options = [command,'--database','lumen_test','--role',role,'--project-id',env['LUMEN_PTY_PROJECT_ID']]
        if endpoint:
            options += ['--endpoint-id',endpoint]
        if command == 'webhook:create':
            options += ['--url','https://hooks.example.com/','--events','asset.ingested,rendition.ready']
        options += extra or []
        argv = prefix(terminal) + ['src/scripts/provision.ts',*options]
        if not terminal:
            result = subprocess.run(argv, env=env, input=b'', capture_output=True, timeout=30)
            status, output = result.returncode, result.stdout+result.stderr
        else:
            pid, master = pty.fork()
            if pid == 0:
                try:
                    os.execvpe(argv[0], argv, env)
                except BaseException:
                    os._exit(1)
            output, status, answered = b'', None, False
            deadline = time.monotonic()+30
            try:
                while status is None:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('PTY deadline exceeded (transcript suppressed)')
                    if select.select([master],[],[],0.1)[0]:
                        try:
                            chunk=os.read(master,8192)
                        except OSError as error:
                            if error.errno != errno.EIO:
                                raise
                            chunk=b''
                        output += chunk
                        if len(output) > 131072:
                            raise RuntimeError('PTY output bound exceeded')
                    if not answered and b'to confirm:' in output:
                        phrase = command+' lumen_test lumen_test_runner '+env['LUMEN_PTY_PROJECT_ID']+((' '+endpoint) if endpoint else '')
                        os.write(master, ((phrase if confirm else 'cancel')+'\n').encode())
                        answered=True
                    done, raw_status = os.waitpid(pid,os.WNOHANG)
                    if done:
                        status=os.waitstatus_to_exitcode(raw_status)
                        while select.select([master],[],[],0)[0]:
                            try:
                                chunk=os.read(master,8192)
                            except OSError:
                                break
                            if not chunk:
                                break
                            output+=chunk
            finally:
                if status is None:
                    os.kill(pid,signal.SIGKILL);os.waitpid(pid,0)
                os.close(master)
        check(len(output) <= 131072, 'PTY output bound exceeded')
        check(status == expected, 'Unexpected CLI exit status (transcript suppressed)')
        revealed=secret_pattern.findall(output)
        count=1 if expected == 0 and command in ['webhook:create','webhook:rotate-secret'] else 0
        check(len(revealed) == count, 'Secret-reveal count mismatch')
        for secret in all_secrets:
            check(secret not in output, 'Prior secret leaked in CLI output')
        for secret in revealed:
            check(output.count(secret) == 1 and len(base64.urlsafe_b64decode(secret+b'=')) == 32, 'Invalid or repeated secret reveal')
            all_secrets.append(secret)
            env['LUMEN_PTY_EXPECTED_SECRET']=secret.decode()
        check(env['WEBHOOK_ENCRYPTION_KEYS'].encode() not in output, 'Encryption configuration leaked')
        for external_key in json.loads(env['WEBHOOK_ENCRYPTION_KEYS']).values():
            check(external_key.encode() not in output, 'External AES key leaked')
        check(b'encrypted_secret' not in output and b'postgres://' not in output, 'Sensitive persistence details leaked')
        return output
    try:
        helper('setup')
        cli('webhook:create',confirm=False,expected=2)
        check(helper('state')['count'] == 0, 'Cancelled creation mutated the database')
        cli('webhook:create',terminal=False,expected=1)
        check(helper('state')['count'] == 0, 'Nonterminal creation mutated the database')
        cli('webhook:create')
        state=helper('state');check(state['count']==1,'Creation did not commit')
        endpoint=state['rows'][0]['id'];env['LUMEN_PTY_ENDPOINT_ID']=endpoint
        check(helper('state')['matches'],'Revealed secret does not match committed ciphertext')
        cli('webhook:list',terminal=False);cli('webhook:show',endpoint,terminal=False)
        cli('webhook:disable',endpoint);check(not helper('state')['rows'][0]['enabled'],'Disable did not commit')
        cli('webhook:enable',endpoint);check(helper('state')['rows'][0]['enabled'],'Enable did not commit')
        predecessor=helper('state')['rows'][0]['signingKeyId']
        cli('webhook:rotate-secret',endpoint)
        state=helper('state');check(state['rows'][0]['previous']==predecessor and state['matches'],'Rotation persistence/reveal mismatch')
        cli('webhook:rotate-secret',endpoint,expected=1)
        cli('webhook:retire-previous-secret',endpoint);check(helper('state')['rows'][0]['previous'] is None,'Retirement did not commit')
        cli('webhook:retire-previous-secret',endpoint)
        # Configured/explicit role mismatch is rejected without disclosing connection details.
        cli('webhook:list',terminal=False,expected=1,role='wrong_role')
        check(helper('state')['count']==1,'Unexpected CLI mutations')
    finally:
        helper('cleanup')
        for name in run_names:
            found=subprocess.run(docker+['inspect',name],capture_output=True,timeout=10)
            if found.returncode == 0:
                container=json.loads(found.stdout)[0]
                check(container['Config']['Labels'].get('com.docker.compose.project') == args.project,'Refusing foreign container cleanup')
                capture(docker+['stop','--time','2',name]);capture(docker+['rm',name])
    print('PTY lifecycle: PASS; all seven commands exercised; create/rotate each revealed once after verified persistence; checks='+str(checks))

if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('PTY verification failed; transcript and internal details suppressed.', file=sys.stderr)
        sys.exit(1)
