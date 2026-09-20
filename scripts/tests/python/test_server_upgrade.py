"""Offline regression checks for the Ubuntu 20.04 updater. No Docker/server mutations."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('edrc_upgrade', ROOT / 'deploy/selfhost/upgrade.py')
upgrade = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upgrade)


class UpgradeTests(unittest.TestCase):
    def test_python38_syntax(self):
        ast.parse((ROOT / 'deploy/selfhost/upgrade.py').read_text(), feature_version=(3, 8))

    def test_materialized_compose_dollars_are_escaped_exactly_once(self):
        data = {'services': {'auth': {'environment': {
            'GOTRUE_SMTP_PASS': 'a$HOME-${UNSET}-$${nested}-"quote"-\\last',
            'GOTRUE_JWT_SECRET': 'test$secret',
        }, 'command': ['sh', '-c', 'echo "$RUNTIME_VAR"']}}}
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'compose.json'
            upgrade.compose_write(file, data)
            raw = json.loads(file.read_text())
            self.assertIn('$$HOME', raw['services']['auth']['environment']['GOTRUE_SMTP_PASS'])
            self.assertEqual(upgrade.dollar_strings(raw, '$$', '$'), data)
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
            with patch.object(upgrade, 'run', return_value=file.read_text()):
                self.assertEqual(upgrade.compose_read({'project':'test', 'directory':directory, 'files':[str(file)]}), data)

    def test_compose_roundtrip_refuses_silent_secret_changes(self):
        original = {'services': {'web': {'environment': {'TOKEN':'test$pass'}}}}
        changed = {'services': {'web': {'environment': {'TOKEN':'test'}}}}
        with patch.object(upgrade, 'compose_read', return_value=changed):
            with self.assertRaisesRegex(upgrade.UpgradeError, 'environment'):
                upgrade.assert_compose_roundtrip({}, original)

    def test_dotenv_quotes_dollars_backslashes_and_unicode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env.production'
            values = {'PASS': 'x$HOME-"quoted"-\\ends\\', 'NAME': "Кольцо: pilot's name # hello"}
            upgrade.write_env(path, values)
            for line in path.read_text().splitlines():
                key, encoded = line.split('=', 1)
                self.assertEqual(json.loads(encoded).replace('$$', '$'), values[key])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_dotenv_rejects_multiline_or_invalid_names(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env.production'
            for values in [{'PASSWORD':'line\nbreak'}, {'PASSWORD':'nul\x00data'}, {'BAD-NAME':'value'}]:
                with self.assertRaises(upgrade.UpgradeError):
                    upgrade.write_env(path, values)

    def test_development_mailboxes_and_placeholders_do_not_enable_signup(self):
        for env in [{}, {'GOTRUE_SMTP_HOST':'supabase-mail', 'GOTRUE_SMTP_ADMIN_EMAIL':'admin@example.com'},
                    {'GOTRUE_SMTP_HOST':'smtp.example.com', 'GOTRUE_SMTP_ADMIN_EMAIL':'admin@edringcolony.ru'},
                    {'GOTRUE_SMTP_HOST':'smtp.mail.ru', 'GOTRUE_SMTP_ADMIN_EMAIL':'admin@edringcolony.ru',
                     'GOTRUE_SMTP_USER':'test', 'GOTRUE_SMTP_PASS':''}]:
            self.assertFalse(upgrade.smtp_ready(env))
            self.assertEqual(upgrade.auth_environment({}, env)['GOTRUE_DISABLE_SIGNUP'], 'true')

    def test_real_smtp_and_trusted_relay_are_supported(self):
        base = {'GOTRUE_SMTP_HOST':'smtp.mail.ru', 'GOTRUE_SMTP_ADMIN_EMAIL':'admin@edringcolony.ru'}
        self.assertTrue(upgrade.smtp_ready(base))
        self.assertTrue(upgrade.smtp_ready({**base, 'GOTRUE_SMTP_USER':'sender', 'GOTRUE_SMTP_PASS':'secret$not-real'}))

    def test_auth_configuration_preserves_keys_credentials_and_other_redirects(self):
        original = {'GOTRUE_JWT_SECRET':'existing$secret', 'GOTRUE_DB_DATABASE_URL':'postgres://untouched',
                    'GOTRUE_URI_ALLOW_LIST':'https://other-approved.example/callback',
                    'GOTRUE_EXTERNAL_DISCORD_ENABLED':'true', 'GOTRUE_EXTERNAL_DISCORD_CLIENT_ID':'existing-id',
                    'GOTRUE_EXTERNAL_DISCORD_SECRET':'existing-private-key',
                    'GOTRUE_EXTERNAL_DISCORD_REDIRECT_URI':'https://old.supabase.co/auth/v1/callback'}
        new = upgrade.auth_environment(original, {})
        for key in ['GOTRUE_JWT_SECRET','GOTRUE_DB_DATABASE_URL','GOTRUE_EXTERNAL_DISCORD_SECRET','GOTRUE_EXTERNAL_DISCORD_CLIENT_ID']:
            self.assertEqual(new[key], original[key])
        self.assertEqual(new['GOTRUE_MAILER_AUTOCONFIRM'], 'false')
        self.assertEqual(new['GOTRUE_PASSWORD_MIN_LENGTH'], '12')
        self.assertEqual(new['GOTRUE_EXTERNAL_DISCORD_REDIRECT_URI'], upgrade.SUPABASE + '/auth/v1/callback')
        self.assertIn('https://other-approved.example/callback', new['GOTRUE_URI_ALLOW_LIST'])
        self.assertIn(upgrade.SITE + '/auth/email', new['GOTRUE_URI_ALLOW_LIST'])
        self.assertIn('/auth/templates/recovery', new['GOTRUE_MAILER_TEMPLATES_RECOVERY'])
        self.assertNotEqual(new, original)
        self.assertEqual(original['GOTRUE_EXTERNAL_DISCORD_REDIRECT_URI'], 'https://old.supabase.co/auth/v1/callback')

    def test_cron_filter_keeps_backup_and_unrelated_jobs_without_leaking_old_secret(self):
        text = '# cron\n30 2 * * * root /opt/ed-ring-colony/backup.sh\n' \
               '*/5 * * * * root curl -H "Authorization: Bearer not-real" https://edringcolony.ru/api/cron/capi-sync\n' \
               '0 1 * * * root /usr/bin/updatedb\n'
        result, count = upgrade.strip_site_cron(text)
        self.assertEqual(count, 1)
        self.assertIn('/backup.sh', result)
        self.assertIn('/updatedb', result)
        self.assertNotIn('not-real', result)
        self.assertIn('disabled by edrc', result)

    def test_github_active_schedules_block_handoff_but_exe_is_allowed(self):
        workflows = [{'path':'.github/workflows/' + name, 'state':'active','name':name} for name in upgrade.LEGACY_WORKFLOWS]
        with self.assertRaisesRegex(upgrade.UpgradeError, 'GitHub'):
            upgrade.github_schedulers_off(lambda url: {'workflows':workflows})
        allowed = [{'path':'.github/workflows/build-exe.yml','name':'EXE','state':'active'}]
        upgrade.github_schedulers_off(lambda url: {'workflows':allowed} if '/workflows?' in url else {'workflow_runs':[]})

    def test_disabled_workflows_still_require_inflight_runs_to_drain(self):
        def fetch(url):
            if '/workflows?' in url:
                return {'workflows':[{'path':'.github/workflows/galnet-sync.yml','name':'Galnet','state':'disabled_manually'}]}
            return {'workflow_runs':[{'path':'.github/workflows/galnet-sync.yml'}]}
        with self.assertRaisesRegex(upgrade.UpgradeError, 'выполняются'):
            upgrade.github_schedulers_off(fetch)

    def test_incomplete_github_result_fails_closed(self):
        with self.assertRaises(upgrade.UpgradeError):
            upgrade.github_schedulers_off(lambda url: {'workflows':[], 'total_count':101})

    def test_compose_keeps_project_directory_files_and_explicit_env(self):
        context = {'project':'existing-site', 'directory':'/opt/site with spaces',
                   'env_file':'/opt/site env/.env.production', 'files':['/opt/a.yml','/opt/override.json']}
        command = upgrade.dc(context, 'up', '-d', '--no-deps', 'web')
        self.assertEqual(command[:4], ['docker','compose','--project-name','existing-site'])
        self.assertIn('/opt/site with spaces', command)
        self.assertEqual(command[-4:], ['up','-d','--no-deps','web'])
        self.assertNotIn('shell', command)

    def test_discovery_does_not_guess_between_two_websites(self):
        def container(name, site):
            return {'Name':name, 'Id':name, 'Config': {'Env':['NEXT_PUBLIC_SITE_URL='+site],
                'Labels':{'com.docker.compose.service':'web'}, 'Image':'web'}}
        correct = container('web-a', upgrade.SITE)
        other = container('web-b', 'https://unrelated.example')
        self.assertEqual(upgrade.select_container([correct,other], 'web')['Name'], 'web-a')
        with self.assertRaises(upgrade.UpgradeError):
            upgrade.select_container([correct, container('web-c', upgrade.SITE)], 'web')
        self.assertEqual(upgrade.select_container([correct,other], 'web', 'web-b')['Name'], 'web-b')

    def test_no_sql_install_volume_removal_or_automatic_os_upgrade(self):
        source = (ROOT / 'deploy/selfhost/upgrade.py').read_text()
        for forbidden in ['full_schema.sql', 'down --volumes', "'volume', 'rm'", 'apt-get upgrade', 'git reset', 'git clean']:
            # Introductory documentation explicitly says "no git reset".
            self.assertNotIn(forbidden, source.split('STATE_DEFAULT =', 1)[1])
        self.assertIn("'pg_restore', '--list'", source)
        self.assertIn("'--no-deps'", source)
        self.assertIn('GOTRUE_DISABLE_SIGNUP', source)


if __name__ == '__main__':
    unittest.main()
