"""Synthetic snapshot contract; never opens the operational private database."""
import importlib.util
import json
import pathlib
import sqlite3
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('support_snapshot_fixture', HERE / 'publish_snapshot.py')
snapshot_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(snapshot_module)


class SnapshotTests(unittest.TestCase):
    def test_exact_incoming_ids_are_exported_without_raw_mail(self):
        scratch = HERE.parents[1] / '.runtime' / 'qa'
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as temporary:
            root = pathlib.Path(temporary)
            (root / '.private').mkdir()
            (root / 'support-agent-bridge' / 'docs').mkdir(parents=True)
            (root / 'support-agent-bridge' / 'docs' / 'SLA与SOP草案.md').write_text('Synthetic pending policy')
            db = sqlite3.connect(root / '.private' / 'bridge.sqlite3')
            db.executescript('''
                CREATE TABLE tickets(id TEXT,revision INTEGER,inbound_id TEXT,occurred_at REAL,state TEXT);
                CREATE TABLE support_watch_cases(ticket_id TEXT,data TEXT,observed_at REAL);
                CREATE TABLE drafts(id TEXT,ticket_id TEXT,revision INTEGER,inbound_id TEXT,version INTEGER,status TEXT,content TEXT,sources TEXT,created_at REAL);
                CREATE TABLE jobs(status TEXT,ticket_id TEXT,revision INTEGER);
                CREATE TABLE poller_state(last_success REAL);
                CREATE TABLE support_watch_state(name TEXT,last_success REAL);
                CREATE TABLE mail_snapshots(record TEXT);
            ''')
            now = time.time()
            db.execute('INSERT INTO tickets VALUES(?,?,?,?,?)', ('ticket-fixture', 2, 'incoming-new', now, 'pending'))
            db.execute('INSERT INTO support_watch_cases VALUES(?,?,?)', ('ticket-fixture', json.dumps({'ticket_number': 'TEST', 'subject': 'Synthetic problem', 'status': 'Open', 'reasons': []}), now))
            db.execute('INSERT INTO drafts VALUES(?,?,?,?,?,?,?,?,?)', ('draft-fixture', 'ticket-fixture', 1, 'incoming-old', 1, 'pending', 'Synthetic draft', '[]', now))
            db.execute('INSERT INTO mail_snapshots VALUES(?)', ('RAW_PRIVATE_MESSAGE_SENTINEL',))
            db.commit()
            db.close()
            preview = types.ModuleType('preview_data')
            preview.Library = lambda: types.SimpleNamespace(articles={})
            standard = types.ModuleType('standard_answers')
            standard.Catalogue = lambda library: types.SimpleNamespace(items=[])
            with patch.dict(sys.modules, {'preview_data': preview, 'standard_answers': standard}):
                actual = snapshot_module.snapshot(root)
            self.assertEqual(actual['tickets'][0]['inboundId'], 'incoming-new')
            self.assertEqual(actual['drafts'][0]['inboundId'], 'incoming-old')
            self.assertNotIn('RAW_PRIVATE_MESSAGE_SENTINEL', json.dumps(actual))
            self.assertEqual(actual['sla']['status'], 'draft')


if __name__ == '__main__':
    unittest.main()
