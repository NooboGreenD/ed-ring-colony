"""Small, toolkit-free helpers for incremental journal reads (not upload ACKs)."""
import json
from pathlib import Path


def complete_journal_prefix(raw: bytes) -> int:
    """Keep partial UTF-8/JSON buffered; a complete EOF object needs no LF.

    Frontier normally writes JSONL, but closed/copied journals can omit the
    final newline. Only a fully decoded JSON object with an event is safe to
    consume at EOF. A syntactically valid scalar/array is not a journal event.
    """
    prefix = raw.rfind(b'\n') + 1
    tail = raw[prefix:]
    if not tail.strip():
        return len(raw)
    try:
        event = json.loads(tail.decode('utf-8-sig'))
    except (ValueError, UnicodeError):
        return prefix
    if isinstance(event, dict) and isinstance(event.get('event'), str):
        return len(raw)
    return prefix


def journal_files(folder: Path):
    """One stat per file; a file removed during rotation must not abort a tick."""
    entries = []
    for path in folder.glob('Journal.*.log'):
        try:
            entries.append((path, path.stat()))
        except OSError:
            continue
    return sorted(entries, key=lambda entry: (entry[1].st_mtime_ns, entry[0].name))
