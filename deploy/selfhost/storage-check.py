#!/usr/bin/env python3
"""Read-only self-hosted Storage diagnostics. Python 3.8+, local Docker.
No restarts, SQL writes, env edits, remote requests or secret/log/body output.
Service keys stay in memory and are sent only to local Docker-derived endpoints.
"""
import argparse
import base64
import hashlib
import hmac
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location('local_realtime_check', Path(__file__).with_name('realtime-check.py'))
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)


def key_info(key, secret):
    result = {'present': bool(key), 'service_role': None, 'expired': None, 'signature_matches': None}
    if not key:
        return result
    try:
        header, payload, signature = key.split('.')
        claims = common.decode_segment(payload)
        algorithm = common.decode_segment(header).get('alg')
        result['service_role'] = claims.get('role') == 'service_role'
        exp = claims.get('exp')
        result['expired'] = exp <= time.time() if isinstance(exp, (int, float)) else None
        if secret and algorithm == 'HS256':
            expected = base64.urlsafe_b64encode(hmac.new(secret.encode(), (header + '.' + payload).encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
            result['signature_matches'] = hmac.compare_digest(expected, signature)
    except (ValueError, TypeError, AttributeError, UnicodeError):
        pass  # New opaque key formats cannot be verified as legacy HS256 JWTs.
    return result


def probe(origin, path, key):
    if not origin or not key:
        return {'skipped': True}
    connection = None
    try:
        target = urlsplit(origin)
        # Never accept an arbitrary hostname / public URL for service-role probes.
        address = ipaddress.ip_address(target.hostname)
        if target.scheme != 'http' or not (address.is_private or address.is_loopback) or target.username or target.password:
            return {'error': 'UNSAFE_TARGET'}
        connection = http.client.HTTPConnection(str(address), target.port, timeout=8)
        connection.request('GET', path, headers={'Authorization': 'Bearer ' + key, 'apikey': key})
        response = connection.getresponse()
        result = {'status': response.status}
        # No redirects; no response bodies or bucket names in the report.
        if response.status == 200:
            body = response.read(1024 * 1024 + 1)
            if len(body) > 1024 * 1024:
                result['json_array'] = None
            else:
                try:
                    result['json_array'] = isinstance(json.loads(body), list)
                except (ValueError, UnicodeError):
                    result['json_array'] = False
        return result
    except (OSError, ValueError, http.client.HTTPException):
        return {'error': 'CONNECTION_FAILED_OR_TIMEOUT'}
    finally:
        if connection:
            connection.close()


def log_signals(text):
    text = text.lower()
    return {name: any(marker in text for marker in markers) for name, markers in {
        'db_password_failure': ['password authentication failed'],
        'db_connection_failure': ['econnrefused', 'connection terminated', 'too many clients', 'remaining connection slots'],
        'dns_failure': ['enotfound', 'eai_again'],
        'permission_failure': ['permission denied', 'eacces'],
        'disk_full': ['no space left on device', 'enospc'],
        'migration_error': ['migration failed', 'migrationerror', 'failed to run migrations'],
        'jwt_error': ['invalid jwt', 'jwt expired', 'invalid signature'],
    }.items()}


def diagnosis(report):
    if not report['services']['storage']['running']:
        return 'STORAGE_STOPPED_CHECK_LOG_SIGNALS'
    probes = report['probes']
    direct = probes['storage_direct']
    if direct.get('status') != 200 or direct.get('json_array') is False:
        return 'STORAGE_DIRECT_FAILED_CHECK_AUTH_DB_AND_LOGS'
    gateway = probes['kong']
    if gateway.get('status') != 200 or gateway.get('json_array') is False:
        return 'STORAGE_WORKS_CHECK_KONG_ROUTE_NETWORK_AND_KEY'
    studio = probes['storage_with_studio_key']
    if studio.get('status') != 200 or studio.get('json_array') is False:
        return 'CHECK_STUDIO_SERVICE_KEY_OR_MISSING_STUDIO'
    return 'LOCAL_STORAGE_AND_KONG_OK_CHECK_STUDIO_URL_AND_BROWSER_REQUEST'


def collect(project=None):
    storage_candidates = common.containers('storage', project)
    if len(storage_candidates) != 1:
        raise common.DiagnosticError('Нужен ровно один Storage. Укажите --project <compose-project>, если стеков несколько.')
    storage = storage_candidates[0]
    project = storage.get('Config', {}).get('Labels', {}).get('com.docker.compose.project')
    if not project:
        raise common.DiagnosticError('Нет Compose project label; автоматический выбор соседних сервисов небезопасен.')
    selected = {'storage': storage}
    for name in ('kong', 'studio', 'db'):
        candidates = common.containers(name, project)
        if len(candidates) > 1:
            raise common.DiagnosticError('Несколько контейнеров сервиса ' + name + '; выбор неоднозначен.')
        selected[name] = candidates[0] if candidates else {}
    environments = {name: common.env(container) for name, container in selected.items()}
    storage_env = environments['storage']
    key = storage_env.get('SERVICE_KEY') or storage_env.get('SUPABASE_SERVICE_KEY')
    studio_key = environments['studio'].get('SUPABASE_SERVICE_KEY')
    kong_key = environments['kong'].get('SUPABASE_SERVICE_KEY')
    secret = storage_env.get('AUTH_JWT_SECRET') or storage_env.get('JWT_SECRET')
    report = {
        'services': {name: {**common.container_status(container),
                            'restarts': container.get('RestartCount', 0),
                            'oom_killed': bool(container.get('State', {}).get('OOMKilled'))}
                     for name, container in selected.items()},
        'keys': {'storage': key_info(key, secret), 'studio': key_info(studio_key, secret),
                 'kong_matches_storage': kong_key == key if kong_key and key else None,
                 'studio_matches_storage': studio_key == key if studio_key and key else None},
        'studio_api_url_is_internal_kong': environments['studio'].get('SUPABASE_URL', '').rstrip('/') == 'http://kong:8000',
        'shared_storage_kong_network': bool(set(storage.get('NetworkSettings', {}).get('Networks', {})) &
                                            set(selected['kong'].get('NetworkSettings', {}).get('Networks', {}))),
    }
    origin = common.backend_origin(storage, int(storage_env.get('PORT', '5000')))
    gateway = common.backend_origin(selected['kong'], 8000)
    report['probes'] = {
        'storage_direct': probe(origin, '/bucket', key) if report['services']['storage']['running'] else {'skipped': True},
        'kong': probe(gateway, '/storage/v1/bucket', kong_key or key) if report['services']['kong']['running'] else {'skipped': True},
        'storage_with_studio_key': probe(origin, '/bucket', studio_key) if report['services']['storage']['running'] else {'skipped': True},
    }
    result = subprocess.run(['docker', 'logs', '--since', '30m', '--tail', '200', storage['Id']],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
    report['recent_storage_log_signals'] = log_signals(result.stdout + result.stderr) if result.returncode == 0 else {'unavailable': True}
    report['storage_mounts'] = []
    for mount in storage.get('Mounts', []):
        if mount.get('Destination') != '/var/lib/storage':
            continue
        item = {'read_write': bool(mount.get('RW')), 'type': mount.get('Type')}
        try:
            stat = os.statvfs(mount['Source'])
            item['free_bytes'] = stat.f_bavail * stat.f_frsize
            item['free_inodes'] = stat.f_favail
        except (OSError, KeyError):
            item['disk_check_unavailable'] = True
        report['storage_mounts'].append(item)
    report['diagnosis'] = diagnosis(report)
    report['note'] = 'Read-only. Local Docker endpoints only. No raw logs, keys or bucket names. Direct host probes do not prove container DNS or public nginx/Studio connectivity.'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', help='Compose project label of the Supabase stack')
    args = parser.parse_args()
    try:
        report = collect(args.project)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report['diagnosis'].startswith('LOCAL_STORAGE_AND_KONG_OK') else 1
    except common.DiagnosticError as error:
        print(str(error), file=sys.stderr)
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print('Не удалось выполнить диагностику Docker. Сырые ошибки и конфигурация с секретами скрыты.', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
