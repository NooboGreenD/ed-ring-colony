#!/usr/bin/env python3
# ============================================================
# EDDN ZeroMQ Listener → Supabase
# Run: pip install zmq supabase-py
#      python scripts/eddn_listener.py
# ============================================================

import zmq
import zlib
import json
import os
import time
from supabase import create_client, Client

SUPABASE_URL = os.getenv('SUPABASE_URL', 'https://sgukfplhxdhmkqponwft.supabase.co')
SUPABASE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY', '')
EDDN_RELAY = 'tcp://eddn.edcd.io:9500'
BATCH_SIZE = 50
FLUSH_INTERVAL = 10

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def parse_message(raw: bytes) -> dict | None:
    try:
        return json.loads(zlib.decompress(raw).decode('utf-8'))
    except Exception:
        return None

def should_store(msg: dict) -> bool:
    event = msg.get('message', {}).get('event', '')
    return event in ['FSDJump', 'Location', 'Docked', 'Scan', 'SAASignalsFound', 'CarrierJump']

def to_db_row(msg: dict) -> dict:
    m = msg.get('message', {})
    return {
        'schema_ref': msg.get('$schemaRef', 'unknown'),
        'uploader_id': msg.get('header', {}).get('uploaderID'),
        'software_name': msg.get('header', {}).get('softwareName'),
        'system_name': m.get('StarSystem') or m.get('systemName'),
        'system_address': m.get('SystemAddress'),
        'star_pos': m.get('StarPos'),
        'station_name': m.get('StationName'),
        'event_type': m.get('event', 'unknown'),
        'message': m,
    }

def main():
    ctx = zmq.Context()
    sock = ctx.socket(zmq.SUB)
    sock.connect(EDDN_RELAY)
    sock.setsockopt_string(zmq.SUBSCRIBE, '')
    print(f'[EDDN] Connected to {EDDN_RELAY}')
    buffer, last_flush = [], time.time()

    while True:
        try:
            msg = parse_message(sock.recv())
            if not msg or not should_store(msg):
                continue
            buffer.append(to_db_row(msg))
            if len(buffer) >= BATCH_SIZE or (time.time() - last_flush) >= FLUSH_INTERVAL:
                try:
                    supabase.table('eddn_messages').insert(buffer).execute()
                    print(f'[EDDN] Flushed {len(buffer)} messages')
                except Exception as e:
                    print(f'[EDDN] Insert error: {e}')
                buffer, last_flush = [], time.time()
        except KeyboardInterrupt:
            print('\n[EDDN] Shutting down...')
            if buffer:
                try: supabase.table('eddn_messages').insert(buffer).execute()
                except Exception as e: print(f'[EDDN] Final flush error: {e}')
            break
        except Exception as e:
            print(f'[EDDN] Error: {e}')
            time.sleep(5)

if __name__ == '__main__':
    main()
