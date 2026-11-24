"""Brand resources and packaging; core coverage needs no Qt or display."""
import ast
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

UPLOADER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(UPLOADER))
import app_icons
import build_bundle


class FakeIcon:
    def __init__(self, path=''):
        self.path = path
    def isNull(self):
        return not self.path or not Path(self.path).is_file()


class AppIconTests(unittest.TestCase):
    def setUp(self):
        self.qt = mock.patch.dict(sys.modules, {'PySide6.QtGui': SimpleNamespace(QIcon=FakeIcon)})
        self.qt.start()
        self.addCleanup(self.qt.stop)

    def test_source_resources_do_not_depend_on_working_directory(self):
        with tempfile.TemporaryDirectory() as cwd:
            old = Path.cwd()
            try:
                os.chdir(cwd)
                self.assertEqual(app_icons.icon_resource('colonial_helper.ico'), UPLOADER / 'colonial_helper.ico')
                self.assertTrue(app_icons.application_icon().path.endswith('colonial_helper.ico'))
                self.assertTrue(app_icons.tray_icon().path.endswith('colonial_helper_tray.ico'))
            finally:
                os.chdir(old)

    def test_frozen_root_and_embedded_bundle_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'version'
            source.mkdir()
            embed = root / 'app_bundle'
            embed.mkdir()
            with mock.patch.object(app_icons, '__file__', str(source / 'app_icons.py')), \
                 mock.patch.object(sys, '_MEIPASS', str(root), create=True):
                self.assertIsNone(app_icons.icon_resource('colonial_helper.png'))
                (embed / 'colonial_helper.png').write_bytes(b'embedded')
                self.assertEqual(app_icons.icon_resource('colonial_helper.png'), embed / 'colonial_helper.png')
                (root / 'colonial_helper.png').write_bytes(b'frozen')
                self.assertEqual(app_icons.icon_resource('colonial_helper.png'), root / 'colonial_helper.png')
                (source / 'colonial_helper.png').write_bytes(b'updated')
                self.assertEqual(app_icons.icon_resource('colonial_helper.png'), source / 'colonial_helper.png')

    def test_png_decoder_fallback_and_missing_resource_is_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.object(app_icons, '__file__', str(root / 'app_icons.py')), \
                 mock.patch.object(sys, '_MEIPASS', '', create=True):
                self.assertTrue(app_icons.application_icon().isNull())
                self.assertTrue(app_icons.tray_icon().isNull())
                png = root / 'colonial_helper.png'
                png.write_bytes(b'fake PNG for fake decoder')
                self.assertEqual(app_icons.application_icon().path, str(png))
                self.assertEqual(app_icons.tray_icon().path, str(png))

    def test_runtime_bundle_contains_only_explicit_icon_assets_not_master(self):
        names = build_bundle.bundle_files(UPLOADER)
        for name in app_icons.ICON_ASSETS:
            self.assertIn(name, names)
            self.assertTrue((UPLOADER / name).is_file())
        self.assertNotIn('assets/colonial-helper-master.png', names)
        self.assertIn('app_icons.py', names)
        self.assertFalse(any('test_app_icons' in name for name in names))

    def test_real_update_archive_hashes_and_embeds_all_four_runtime_assets(self):
        import hashlib
        import zipfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = build_bundle.build(UPLOADER, root / 'out', '0.0.0', 'beta',
                                          'local test only', '0', None, '')
            entries = {item['path']: item for item in manifest['files']}
            with zipfile.ZipFile(root / 'out' / '0.0.0.zip') as archive:
                self.assertFalse(any('colonial-helper-master' in name for name in archive.namelist()))
                for name in app_icons.ICON_ASSETS:
                    payload = archive.read(name)
                    self.assertEqual(hashlib.sha256(payload).hexdigest(), entries[name]['sha256'])
            build_bundle.embed(UPLOADER, manifest, root / 'embedded')
            for name in app_icons.ICON_ASSETS:
                self.assertEqual((root / 'embedded' / name).read_bytes(), (UPLOADER / name).read_bytes())

    def test_ico_directory_contains_small_and_hidpi_frames(self):
        for name, expected in [('colonial_helper.ico', {16, 20, 24, 32, 40, 48, 64, 128, 256}),
                               ('colonial_helper_tray.ico', {16, 20, 24, 32, 40, 48, 64})]:
            data = (UPLOADER / name).read_bytes()
            zero, kind, count = struct.unpack_from('<HHH', data)
            self.assertEqual((zero, kind), (0, 1))
            sizes = set()
            for i in range(count):
                width, height, _, _, _, depth, size, offset = struct.unpack_from('<BBBBHHII', data, 6 + 16*i)
                self.assertEqual(width, height)
                sizes.add(width or 256)
                self.assertEqual(depth, 32)
                self.assertLessEqual(offset + size, len(data))
            self.assertEqual(sizes, expected)

    def test_exe_and_setup_embed_runtime_files_not_just_pe_resource(self):
        for name in ('build_exe.py', 'build_installer.py'):
            source = (UPLOADER / name).read_text(encoding='utf-8')
            self.assertIn('from app_icons import ICON_ASSETS', source)
            self.assertIn('for asset in ICON_ASSETS:', source)
            self.assertIn('--add-data', source)
            self.assertIn('--icon=', source)

    def test_iconbitmap_cannot_replace_optical_tray_icon_with_detailed_app_icon(self):
        source = ast.parse((UPLOADER / 'helper_window.py').read_text(encoding='utf-8'))
        cls = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == 'HelperWindow')
        method = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == 'iconbitmap')
        node = ast.ClassDef(name='Window', bases=[], keywords=[], body=[method], decorator_list=[])
        env = {'QIcon': FakeIcon, 'icon_resource': app_icons.icon_resource,
               'tray_icon': app_icons.tray_icon}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<iconbitmap>', 'exec'), env)
        window = env['Window']()
        window.setWindowIcon = mock.Mock()
        window._tray = mock.Mock()
        window.iconbitmap('colonial_helper.ico')
        self.assertTrue(window.setWindowIcon.call_args.args[0].path.endswith('colonial_helper.ico'))
        self.assertTrue(window._tray.setIcon.call_args.args[0].path.endswith('colonial_helper_tray.ico'))

    def test_transparency_and_optical_frames(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest('Pillow is only needed for artwork-generation checks')
        for name in ('colonial_helper.png', 'colonial_helper_tray.png'):
            with Image.open(UPLOADER / name) as image:
                self.assertEqual(image.mode, 'RGBA')
                self.assertEqual(image.getpixel((0, 0))[3], 0)
                self.assertEqual(image.size[0], image.size[1])
        with Image.open(UPLOADER / 'colonial_helper.ico') as app, Image.open(UPLOADER / 'colonial_helper_tray.ico') as tray:
            for size in (16, 20, 24, 32):
                self.assertEqual(app.ico.getimage((size, size)).tobytes(), tray.ico.getimage((size, size)).tobytes())
            self.assertNotEqual(app.ico.getimage((64, 64)).tobytes(), tray.ico.getimage((64, 64)).tobytes())


if __name__ == '__main__':
    unittest.main()
