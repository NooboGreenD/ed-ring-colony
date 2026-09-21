"""Tests use a local RFC 6455 stub, never a production key or Supabase."""
import ast
import base64
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import socketserver
import ssl
import struct
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('realtime_check', ROOT / 'deploy/selfhost/realtime-check.py')
diag = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(diag)


def jwt(role='anon', secret='test-not-a-real-secret', expiry=None, header=None):
    enc = lambda obj: base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b'=').decode()
    data = enc(header or {'alg':'HS256'}) + '.' + enc({'role':role, 'exp':expiry or time.time()+3600})
    return data + '.' + base64.urlsafe_b64encode(hmac.new(secret.encode(), data.encode(), hashlib.sha256).digest()).rstrip(b'=').decode()


class WebSocketStub(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(2)
        reader = self.request.makefile('rb')
        self.server.request_line = reader.readline().decode().strip()
        headers = {}
        while True:
            line = reader.readline().decode().strip()
            if not line:
                break
            key, value = line.split(':', 1)
            headers[key.lower()] = value.strip()
        self.server.headers = headers
        status = self.server.reply_status
        if status != 101:
            # The script must not print redirect targets / error bodies containing keys.
            body = b'secret-must-not-be-printed'
            self.request.sendall(('HTTP/1.1 %s Test\r\nLocation: https://evil.example/?apikey=secret-must-not-be-printed\r\nContent-Length: %s\r\n\r\n' % (status, len(body))).encode() + body)
            return
        accept = base64.b64encode(hashlib.sha1((headers['sec-websocket-key']+diag.WS_GUID).encode()).digest()).decode()
        if self.server.invalid_accept:
            accept = 'wrong'
        self.request.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n' % accept).encode())
        if self.server.invalid_accept:
            return
        _, length = reader.read(2)
        if length & 0x7f == 126:
            count = struct.unpack('!H', reader.read(2))[0]
        else:
            count = length & 0x7f
        mask = reader.read(4)
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(reader.read(count)))
        self.server.message = json.loads(payload)
        response = json.dumps([None,'diag','phoenix','phx_reply',{'status':'ok','response':{}}]).encode()
        self.request.sendall(bytes([0x89,1])+b'x')  # Exercise ping/pong before heartbeat response.
        self.request.sendall(bytes([0x81,len(response)])+response)
        # Keep the transport open until the client closes normally.
        try:
            while reader.read(1):
                pass
        except OSError:
            pass


class Server(socketserver.TCPServer):
    allow_reuse_address = True
    def __init__(self, status=101, invalid_accept=False):
        super().__init__(('0.0.0.0',0),WebSocketStub)
        self.reply_status, self.invalid_accept = status, invalid_accept
        self.thread = threading.Thread(target=self.serve_forever,daemon=True)
        self.thread.start()
    def close(self):
        self.shutdown(); self.server_close(); self.thread.join(timeout=3)
    @property
    def origin(self):
        return 'http://127.0.0.1:' + str(self.server_address[1])


class RealtimeDiagnosticsTests(unittest.TestCase):
    def test_python38_grammar(self):
        ast.parse((ROOT/'deploy/selfhost/realtime-check.py').read_text(),feature_version=(3,8))

    def test_upgrade_and_phoenix_heartbeat_are_both_required(self):
        server = Server()
        try:
            key = jwt()
            result = diag.websocket_probe(server.origin,'/realtime/v1/websocket',key,host='supabase.edringcolony.ru')
            self.assertEqual(result,{'http_status':101,'upgrade_valid':True,'phoenix_heartbeat':True})
            self.assertEqual(server.headers['origin'],diag.SITE)
            self.assertEqual(server.headers['host'],'supabase.edringcolony.ru')
            self.assertIn('/realtime/v1/websocket?apikey=',server.request_line)
            self.assertIn('&vsn=2.0.0',server.request_line)
            self.assertNotIn('&amp;',server.request_line)
            self.assertEqual(server.message,[None,'diag','phoenix','heartbeat',{}])
            self.assertNotIn(key,json.dumps(result))
        finally:
            server.close()

    def test_redirects_and_errors_never_follow_or_echo_keys(self):
        for status in [301,400,401,403,404,426,502,503]:
            server = Server(status=status)
            try:
                result = diag.websocket_probe(server.origin,'/realtime/v1/websocket',jwt())
                self.assertEqual(result['http_status'],status)
                self.assertFalse(result['upgrade_valid'])
                self.assertNotIn('secret-must-not-be-printed',json.dumps(result))
                self.assertNotIn('evil.example',json.dumps(result))
            finally:
                server.close()

    def test_spoofed_101_does_not_count_as_websocket_success(self):
        server = Server(invalid_accept=True)
        try:
            result = diag.websocket_probe(server.origin,'/socket/websocket',jwt())
            self.assertEqual(result['http_status'],101)
            self.assertFalse(result['upgrade_valid'])
            self.assertEqual(result['error'],'INVALID_UPGRADE')
        finally:
            server.close()

    def test_tls_verification_is_not_disabled_and_errors_are_redacted(self):
        with patch.object(diag.socket,'create_connection',side_effect=ssl.SSLCertVerificationError('secret URL must not be printed')):
            result = diag.websocket_probe(diag.PUBLIC,'/realtime/v1/websocket',jwt())
        self.assertEqual(result['error'],'TLS_CERTIFICATE_VERIFY_FAILED')
        self.assertNotIn('secret URL',json.dumps(result))
        source=(ROOT/'deploy/selfhost/realtime-check.py').read_text()
        self.assertIn('ssl.create_default_context()',source)
        self.assertNotIn('CERT_NONE',source)
        self.assertNotIn('_create_unverified_context',source)

    def test_public_key_checks_detect_mismatch_and_expiry_without_printing_claims(self):
        key = jwt()
        self.assertTrue(diag.key_checks(key,{'API_JWT_SECRET':'test-not-a-real-secret'})['realtime_hs256_matches'])
        self.assertFalse(diag.key_checks(key,{'API_JWT_SECRET':'wrong'})['realtime_hs256_matches'])
        self.assertTrue(diag.key_checks(jwt(expiry=1),{})['expired'])
        self.assertNotIn(key,json.dumps(diag.key_checks(key,{})))

    def test_secret_service_role_and_malformed_keys_are_refused(self):
        for key in [jwt(role='service_role'),'sb_secret_anything','not-a-jwt','a.b.c',123]:
            with self.assertRaises(diag.DiagnosticError):
                diag.key_checks(key,{})
        self.assertEqual(diag.key_checks('sb_publishable_public',{})['public_key_type'],'publishable')

    def test_docker_port_mapping_and_shared_network_use_the_actual_endpoints(self):
        container = {'NetworkSettings':{'Ports':{'8000/tcp':[{'HostIp':'0.0.0.0','HostPort':'18000'}]}}}
        self.assertEqual(diag.backend_origin(container,8000),'http://127.0.0.1:18000')
        container = {'NetworkSettings':{'Networks':{'unrelated':{'IPAddress':'172.30.0.9'},'supabase':{'IPAddress':'172.20.0.2'}}}}
        self.assertEqual(diag.backend_origin(container,4000,{'supabase'}),'http://172.20.0.2:4000')

    def test_container_health_logs_and_state_errors_are_not_exposed(self):
        container = {'Name':'/test','State':{'Running':True,'Error':'SECRET', 'Health':{'Status':'healthy','Log':['SECRET']}}}
        self.assertNotIn('SECRET',json.dumps(diag.container_status(container)))

    def test_diagnosis_localizes_the_failing_hop(self):
        good={'http_status':101,'upgrade_valid':True,'phoenix_heartbeat':True}
        bad={'http_status':502,'upgrade_valid':False,'phoenix_heartbeat':False}
        report={'realtime':{'running':True},'keys':{},'probes':{'realtime_direct':good,'kong':good,'public_https':bad}}
        self.assertEqual(diag.diagnosis(report),'PUBLIC_PROXY_OR_TLS')
        report['probes']['kong']=bad
        self.assertEqual(diag.diagnosis(report),'KONG_ROUTE_OR_APIKEY')
        report['probes']['realtime_direct']=bad
        self.assertEqual(diag.diagnosis(report),'REALTIME_OR_LOCAL_NETWORK')
        report['realtime']['running']=False
        self.assertEqual(diag.diagnosis(report),'REALTIME_NOT_RUNNING')
        report['keys']['realtime_hs256_matches']=False
        self.assertEqual(diag.diagnosis(report),'REALTIME_JWT_SECRET_MISMATCH')

    def test_healthy_public_and_kong_are_not_misdiagnosed_by_an_unreachable_direct_container(self):
        good={'http_status':101,'upgrade_valid':True,'phoenix_heartbeat':True}
        report={'realtime':{'running':True},'keys':{},'probes':{'kong':good,'public_https':good}}
        self.assertEqual(diag.diagnosis(report),'TRANSPORT_OK_CHECK_BROWSER_AND_SUBSCRIPTIONS')

    def test_proxy_snippet_retains_the_kong_prefix_and_tls_server_is_not_replaced(self):
        text=(ROOT/'deploy/selfhost/nginx-realtime-location.conf').read_text()
        self.assertIn('location ^~ /realtime/v1/',text)
        self.assertIn('proxy_pass http://127.0.0.1:8000;',text)
        self.assertNotIn('proxy_pass http://127.0.0.1:8000/;',text)
        self.assertIn('proxy_http_version 1.1;',text)
        self.assertIn('proxy_set_header Upgrade $http_upgrade;',text)
        self.assertIn('proxy_read_timeout 3600s;',text)
        self.assertIn('proxy_buffering off;',text)
        self.assertIn('access_log off;',text)
        self.assertNotIn('ssl_certificate',text)
        self.assertNotIn('listen 443',text)
        installer=(ROOT/'deploy/selfhost/install.sh').read_text()
        self.assertIn('server_name $SUPA_HOST;\n    location ^~ /realtime/v1/',installer)

if __name__ == '__main__':
    unittest.main()
