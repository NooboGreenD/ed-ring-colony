import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const prelude = `
import importlib.util, json, base64, hmac, hashlib, time
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('storage_check', 'deploy/selfhost/storage-check.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;
function python(code) {
  const result = spawnSync('python3', ['-c', prelude + code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
test('Storage diagnostics verifies key role, expiry and signature without exposing credentials', () => python(`
def enc(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=').decode()
head = enc({'alg':'HS256'})
body = enc({'role':'service_role','exp':time.time()+60})
secret = 'VERY_PRIVATE_SECRET'
sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), (head+'.'+body).encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
key = head+'.'+body+'.'+sig
info = m.key_info(key, secret)
assert info == {'present':True,'service_role':True,'expired':False,'signature_matches':True}
assert m.key_info(key, 'wrong')['signature_matches'] is False
assert m.key_info(None, secret)['present'] is False
assert m.key_info('opaque-key', secret)['signature_matches'] is None
assert secret not in json.dumps(info) and key not in json.dumps(info)
`));
test('Storage diagnostics distinguishes stopped service, backend errors, gateway and Studio failures', () => python(`
r = {'services':{'storage':{'running':False}}, 'probes':{}}
assert m.diagnosis(r).startswith('STORAGE_STOPPED')
r['services']['storage']['running'] = True
r['probes'] = {'storage_direct':{'status':503}}
assert m.diagnosis(r).startswith('STORAGE_DIRECT_FAILED')
r['probes']['storage_direct'] = {'status':200,'json_array':True}
r['probes']['kong'] = {'status':503}
assert m.diagnosis(r).startswith('STORAGE_WORKS_CHECK_KONG')
r['probes']['kong'] = {'status':200,'json_array':True}
r['probes']['storage_with_studio_key'] = {'status':401}
assert m.diagnosis(r).startswith('CHECK_STUDIO')
r['probes']['storage_with_studio_key'] = {'status':200,'json_array':True}
assert m.diagnosis(r).startswith('LOCAL_STORAGE_AND_KONG_OK')
`));
test('Storage probes reject public destinations, do not follow redirects or disclose bodies', () => python(`
# DNS names fail IP validation before any connection.
with patch.object(m.http.client, 'HTTPConnection') as factory:
    assert 'error' in m.probe('http://external.example', '/bucket', 'secret')
    assert m.probe('http://8.8.8.8', '/bucket', 'secret')['error'] == 'UNSAFE_TARGET'
    factory.assert_not_called()
    conn = factory.return_value
    conn.getresponse.return_value.status = 302
    assert m.probe('http://127.0.0.1:5000', '/bucket', 'secret') == {'status':302}
    assert conn.request.call_count == 1
    conn.getresponse.return_value.read.assert_not_called()
    conn.getresponse.return_value.status = 200
    conn.getresponse.return_value.read.return_value = b'[{"private_bucket":"SECRET_NAME"}]'
    result = m.probe('http://127.0.0.1:5000', '/bucket', 'secret')
    assert result == {'status':200,'json_array':True}
    assert 'SECRET_NAME' not in json.dumps(result)
`));
test('Storage report suppresses raw logs/env and inspects one Compose project without writes', () => python(`
def container(service):
    return {'Id':service, 'Name':service, 'State':{'Running':True}, 'Config':{
        'Labels':{'com.docker.compose.project':'local'},
        'Env':['SERVICE_KEY=TOP_SECRET','SUPABASE_SERVICE_KEY=TOP_SECRET', 'AUTH_JWT_SECRET=PRIVATE', 'SUPABASE_URL=http://kong:8000']},
        'NetworkSettings':{'Networks':{'local':{'IPAddress':'172.18.0.4'}}}}
class Logs:
    returncode=0
    stdout='password authentication failed for user TOP_SECRET PRIVATE'
    stderr=''
with patch.object(m.common, 'containers', side_effect=lambda service, project=None: [container(service)]), \\
     patch.object(m, 'probe', return_value={'status':200,'json_array':True}), \\
     patch.object(m.subprocess, 'run', return_value=Logs()) as run:
    result = m.collect()
    text = json.dumps(result)
    assert 'TOP_SECRET' not in text and 'PRIVATE' not in text
    assert result['recent_storage_log_signals']['db_password_failure'] is True
    assert result['keys']['kong_matches_storage'] is True
    assert result['shared_storage_kong_network'] is True
    assert run.call_args.args[0][:2] == ['docker','logs']
with patch.object(m.common, 'containers', return_value=[container('one'),container('two')]):
    try: m.collect()
    except m.common.DiagnosticError: pass
    else: raise AssertionError('ambiguous project accepted')
`));
