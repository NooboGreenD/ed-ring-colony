#!/usr/bin/env python3
"""Read-only Realtime diagnostics, Python 3.8+ / existing local Docker.
Never prints keys, env, response bodies, request URLs with query strings or raw logs.
No container restarts, config edits, subscriptions, schema changes or TLS bypasses.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import time
from urllib.parse import urlencode, urlsplit

SITE = 'https://edringcolony.ru'
PUBLIC = 'https://supabase.edringcolony.ru'
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
TIMEOUT = 8
MAX_FRAME = 65536

class DiagnosticError(Exception):
    pass


def command(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
    if result.returncode:
        raise DiagnosticError('Команда диагностики Docker не выполнена; проверьте sudo и Docker. Вывод с секретами скрыт.')
    return result.stdout


def containers(service, project=None, explicit=None):
    if explicit:
        if explicit.startswith('-'):
            raise DiagnosticError('Некорректное имя контейнера.')
        ids = [explicit]
    else:
        args = ['docker', 'ps', '-a', '-q', '--filter', 'label=com.docker.compose.service=' + service]
        if project:
            args += ['--filter', 'label=com.docker.compose.project=' + project]
        ids = command(args).split()
    return json.loads(command(['docker', 'inspect'] + ids)) if ids else []


def env(container):
    return dict(item.split('=', 1) for item in container.get('Config', {}).get('Env', []) if '=' in item)


def container_status(container):
    state = container.get('State', {})
    # Deliberately omit State.Error and Health.Log: either may contain credentials.
    return {'name': container.get('Name', '').lstrip('/'), 'running': bool(state.get('Running')),
            'health': state.get('Health', {}).get('Status', 'not_configured')}


def backend_origin(container, port, shared_networks=()):
    network = container.get('NetworkSettings', {})
    bindings = network.get('Ports', {}).get(str(port) + '/tcp') or []
    for binding in sorted(bindings, key=lambda item: ':' in item.get('HostIp', '')):
        host = binding.get('HostIp') or '127.0.0.1'
        host = {'0.0.0.0': '127.0.0.1', '::': '::1'}.get(host, host)
        try:
            host = str(ipaddress.ip_address(host))
            host_port = int(binding['HostPort'])
        except (ValueError, KeyError):
            continue
        if not 1 <= host_port <= 65535:
            continue
        return 'http://%s:%s' % ('[' + host + ']' if ':' in host else host, host_port)
    networks = network.get('Networks', {})
    for name in sorted(networks, key=lambda name: name not in shared_networks):
        address = networks[name].get('IPAddress')
        if address:
            return 'http://%s:%s' % (str(ipaddress.ip_address(address)), port)
    if container.get('HostConfig', {}).get('NetworkMode') == 'host':
        return 'http://127.0.0.1:%s' % port
    return None


def decode_segment(segment):
    return json.loads(base64.urlsafe_b64decode(segment + '=' * (-len(segment) % 4)))


def key_checks(key, realtime_env):
    if not isinstance(key, str) or len(key) > 8192:
        raise DiagnosticError('Некорректный публичный ключ; его значение не выводится.')
    if key.startswith('sb_publishable_'):
        return {'public_key_type': 'publishable', 'expired': None, 'realtime_hs256_matches': None}
    try:
        parts = key.split('.')
        if len(parts) != 3:
            raise ValueError()
        header, payload = decode_segment(parts[0]), decode_segment(parts[1])
        if not isinstance(header, dict) or not isinstance(payload, dict):
            raise ValueError()
        if payload.get('role') != 'anon':
            raise ValueError()
        expires = payload.get('exp')
        expired = expires <= time.time() if isinstance(expires, (int, float)) else None
        matches = None
        if header.get('alg') == 'HS256' and realtime_env.get('API_JWT_SECRET'):
            signature = base64.urlsafe_b64encode(hmac.new(realtime_env['API_JWT_SECRET'].encode(),
                (parts[0] + '.' + parts[1]).encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
            matches = hmac.compare_digest(signature, parts[2])
        return {'public_key_type': 'anon_jwt', 'expired': expired, 'realtime_hs256_matches': matches}
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise DiagnosticError('Не найден корректный публичный anon/publishable ключ. Service-role/secret ключи для этой проверки запрещены.')


def client_frame(opcode, data):
    mask = secrets.token_bytes(4)
    length = len(data)
    if length > MAX_FRAME:
        raise DiagnosticError('Слишком большой диагностический кадр.')
    prefix = bytes([0x80 | opcode])
    prefix += bytes([0x80 | length]) if length < 126 else bytes([0x80 | 126]) + struct.pack('!H', length)
    return prefix + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(data))


class SocketReader:
    def __init__(self, sock, buffered=b'', deadline=None):
        self.sock, self.buffer = sock, buffered
        self.deadline = deadline or time.monotonic() + TIMEOUT

    def read(self, size):
        while len(self.buffer) < size:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            self.sock.settimeout(remaining)
            part = self.sock.recv(max(1, min(8192, size - len(self.buffer))))
            if not part:
                raise EOFError()
            self.buffer += part
        result, self.buffer = self.buffer[:size], self.buffer[size:]
        return result


def server_frame(reader):
    first, second = reader.read(2)
    # No compression/extensions negotiated; server frames must not be masked.
    if first & 0x70 or second & 0x80 or not first & 0x80:
        raise ValueError('unsupported frame')
    length = second & 0x7f
    if length == 126:
        length = struct.unpack('!H', reader.read(2))[0]
    elif length == 127:
        length = struct.unpack('!Q', reader.read(8))[0]
    if length > MAX_FRAME:
        raise ValueError('frame too large')
    opcode = first & 0xf
    if opcode >= 8 and length > 125:
        raise ValueError('invalid control frame')
    return opcode, reader.read(length)


def websocket_probe(origin, path, key, host=None):
    result = {'http_status': None, 'upgrade_valid': False, 'phoenix_heartbeat': False}
    sock = None
    try:
        url = urlsplit(origin)
        if url.scheme not in ('http', 'https') or url.username or url.password or url.query or url.fragment:
            raise ValueError('bad origin')
        port = url.port or (443 if url.scheme == 'https' else 80)
        sock = socket.create_connection((url.hostname, port), timeout=TIMEOUT)
        if url.scheme == 'https':
            context = ssl.create_default_context()
            context.set_alpn_protocols(['http/1.1'])
            sock = context.wrap_socket(sock, server_hostname=url.hostname)
        sock.settimeout(TIMEOUT)
        ws_key = base64.b64encode(secrets.token_bytes(16)).decode()
        authority = host or url.netloc
        target = path + '?' + urlencode({'apikey': key, 'vsn': '2.0.0'})
        request = ('GET %s HTTP/1.1\r\nHost: %s\r\nOrigin: %s\r\nConnection: Upgrade\r\n'
                   'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n\r\n') % (target, authority, SITE, ws_key)
        sock.sendall(request.encode('ascii'))
        raw = b''
        deadline = time.monotonic() + TIMEOUT
        while b'\r\n\r\n' not in raw:
            if len(raw) > 16384:
                raise ValueError('headers too large')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            sock.settimeout(remaining)
            part = sock.recv(4096)
            if not part:
                raise EOFError()
            raw += part
        head, rest = raw.split(b'\r\n\r\n', 1)
        lines = head.decode('iso-8859-1').split('\r\n')
        status = int(lines[0].split()[1])
        result['http_status'] = status
        if status != 101:
            return result  # No redirects, bodies, Location headers or query strings in output.
        headers = dict((name.strip().lower(), value.strip()) for name, value in
                       (line.split(':', 1) for line in lines[1:] if ':' in line))
        expected = base64.b64encode(hashlib.sha1((ws_key + WS_GUID).encode()).digest()).decode()
        if headers.get('sec-websocket-accept') != expected or headers.get('upgrade', '').lower() != 'websocket' or \
                'upgrade' not in [token.strip().lower() for token in headers.get('connection', '').split(',')]:
            result['error'] = 'INVALID_UPGRADE'
            return result
        result['upgrade_valid'] = True
        # Heartbeat only. No channel join, tables, broadcast/presence or data writes.
        message = json.dumps([None, 'diag', 'phoenix', 'heartbeat', {}]).encode()
        sock.sendall(client_frame(1, message))
        reader = SocketReader(sock, rest)
        for _ in range(16):
            opcode, data = server_frame(reader)
            if opcode == 9:
                sock.sendall(client_frame(10, data))
            elif opcode == 8:
                result['error'] = 'CLOSED_BEFORE_HEARTBEAT'
                return result
            elif opcode == 1:
                reply = json.loads(data)
                if isinstance(reply, list) and len(reply) == 5 and reply[1:4] == ['diag', 'phoenix', 'phx_reply']:
                    result['phoenix_heartbeat'] = isinstance(reply[4], dict) and reply[4].get('status') == 'ok'
                    break
        sock.sendall(client_frame(8, struct.pack('!H', 1000)))
        return result
    except ssl.SSLCertVerificationError:
        result['error'] = 'TLS_CERTIFICATE_VERIFY_FAILED'
    except ssl.SSLError:
        result['error'] = 'TLS_CONNECTION_FAILED'
    except (socket.timeout, TimeoutError):
        result['error'] = 'TIMEOUT'
    except (OSError, ValueError, EOFError, DiagnosticError):
        result['error'] = 'CONNECTION_OR_PROTOCOL_ERROR'
    finally:
        if sock is not None:
            sock.close()
    return result


def tenant_health(origin, key, tenant):
    connection = None
    try:
        target = urlsplit(origin)
        connection = http.client.HTTPConnection(target.hostname, target.port, timeout=TIMEOUT)
        connection.request('GET', '/api/tenants/' + tenant + '/health', headers={'Authorization': 'Bearer ' + key})
        response = connection.getresponse()
        return response.status  # Body and key deliberately omitted.
    except (OSError, ValueError, http.client.HTTPException):
        return None
    finally:
        if connection:
            connection.close()


def nginx_summary():
    if not shutil.which('nginx'):
        return {'available_on_host': False}
    result = subprocess.run(['nginx', '-T'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
    files = []
    parts = re.split(r'^# configuration file (.+):\s*$', result.stdout, flags=re.M)
    for index in range(1, len(parts) - 1, 2):
        names = re.findall(r'\bserver_name\s+([^;]+);', parts[index + 1])
        if any('supabase.edringcolony.ru' in value.split() for value in names):
            files.append(parts[index])
    return {'available_on_host': True, 'config_test_passed': result.returncode == 0,
            'candidate_config_files': files}


def diagnosis(report):
    probes = report.get('probes', {})
    direct, gateway, public = (probes.get(name, {}) for name in ('realtime_direct', 'kong', 'public_https'))
    healthy = lambda probe: probe.get('upgrade_valid') and probe.get('phoenix_heartbeat')
    if report.get('keys', {}).get('expired'):
        return 'PUBLIC_KEY_EXPIRED'
    if report.get('keys', {}).get('realtime_hs256_matches') is False:
        return 'REALTIME_JWT_SECRET_MISMATCH'
    if not report.get('realtime', {}).get('running', False):
        return 'REALTIME_NOT_RUNNING'
    if healthy(gateway) and not healthy(public):
        return 'PUBLIC_PROXY_OR_TLS'  # Not proof that Nginx, specifically, is responsible.
    if healthy(direct) and not healthy(gateway):
        return 'KONG_ROUTE_OR_APIKEY'
    if healthy(public) and healthy(gateway):
        return 'TRANSPORT_OK_CHECK_BROWSER_AND_SUBSCRIPTIONS'
    if not healthy(direct):
        return 'REALTIME_OR_LOCAL_NETWORK'
    return 'NEEDS_SERVER_LOG_REVIEW'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kong-container', help='Explicit existing Kong container name if discovery is ambiguous')
    parser.add_argument('--web-container', help='Explicit site container name if service is not called web')
    args = parser.parse_args()
    try:
        if not shutil.which('docker'):
            raise DiagnosticError('Не найден Docker. Запустите проверку на сервере установки.')
        endpoint = os.environ.get('DOCKER_HOST') or command(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).strip()
        if not endpoint.startswith('unix://'):
            raise DiagnosticError('Нужен локальный Docker socket, не удалённый DOCKER_HOST.')
        gateways = containers('kong', explicit=args.kong_container)
        if len(gateways) != 1:
            raise DiagnosticError('Укажите единственный нужный Kong через --kong-container ИМЯ. Секреты не требуются.')
        gateway = gateways[0]
        project = (gateway['Config'].get('Labels') or {}).get('com.docker.compose.project')
        if not project:
            raise DiagnosticError('У Kong отсутствует Compose project label; автоматический выбор Realtime небезопасен.')
        realtime = containers('realtime', project=project)
        if len(realtime) != 1:
            raise DiagnosticError('В выбранном Compose-проекте не найден единственный сервис realtime.')
        realtime = realtime[0]
        web = containers('web', explicit=args.web_container)
        if not args.web_container:
            web = [item for item in web if env(item).get('NEXT_PUBLIC_SUPABASE_URL', '').rstrip('/') == PUBLIC]
        if len(web) > 1:
            raise DiagnosticError('Несколько сайтов: укажите --web-container ИМЯ, чтобы не проверять чужой ключ.')
        web_env = env(web[0]) if web else {}
        gateway_env, realtime_env = env(gateway), env(realtime)
        key = web_env.get('NEXT_PUBLIC_SUPABASE_ANON_KEY') or gateway_env.get('SUPABASE_ANON_KEY')
        if not key:
            raise DiagnosticError('Не найден публичный anon-ключ в контейнерах; значения ключей присылать не нужно.')
        report = {'read_only': True, 'kong': container_status(gateway), 'realtime': container_status(realtime),
                  'frontend_key_checked': bool(web_env.get('NEXT_PUBLIC_SUPABASE_ANON_KEY')),
                  'frontend_url_matches': web_env['NEXT_PUBLIC_SUPABASE_URL'].rstrip('/') == PUBLIC if web_env.get('NEXT_PUBLIC_SUPABASE_URL') else None,
                  'keys': key_checks(key, realtime_env), 'nginx': nginx_summary(), 'probes': {}}
        allowed = [gateway_env.get(name) for name in ('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY') if gateway_env.get(name)]
        report['keys']['matches_gateway_public_key'] = key in allowed if allowed else None
        report['seed_self_host'] = realtime_env.get('SEED_SELF_HOST', '').lower() == 'true'
        shared = gateway.get('NetworkSettings', {}).get('Networks', {}).keys()
        gateway_url = backend_origin(gateway, 8000)
        realtime_url = backend_origin(realtime, int(realtime_env.get('PORT', '4000')), shared)
        report['kong_local_origin'] = gateway_url
        tenant_host = realtime.get('Name', '').lstrip('/')
        tenant = tenant_host.split('.')[0]
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', tenant) or '.' not in tenant_host:
            report['realtime_host_warning'] = 'Expected tenant-prefixed name, normally realtime-dev.supabase-realtime; do not rename blindly.'
        if gateway_url and report['kong']['running']:
            report['probes']['kong'] = websocket_probe(gateway_url, '/realtime/v1/websocket', key, host='supabase.edringcolony.ru')
        if realtime_url and report['realtime']['running']:
            report['probes']['realtime_direct'] = websocket_probe(realtime_url, '/socket/websocket', key, host=tenant_host)
            if re.fullmatch(r'[a-zA-Z0-9_-]+', tenant):
                report['tenant_health_http'] = tenant_health(realtime_url, key, tenant)
        report['probes']['public_https'] = websocket_probe(PUBLIC, '/realtime/v1/websocket', key)
        report['diagnosis'] = diagnosis(report)
        report['note'] = 'HTTP 101 + heartbeat проверяют транспорт, не публикации таблиц/RLS. Ключи и тела ответов не выводятся.'
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report['diagnosis'] == 'TRANSPORT_OK_CHECK_BROWSER_AND_SUBSCRIPTIONS' else 1
    except DiagnosticError as error:
        print('ОСТАНОВЛЕНО: ' + str(error), file=sys.stderr)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print('ОСТАНОВЛЕНО: не удалось прочитать конфигурацию/сеть. Сырые данные с секретами скрыты.', file=sys.stderr)
    return 2

if __name__ == '__main__':
    sys.exit(main())
