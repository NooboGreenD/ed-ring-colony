"""Check facade exports without needing native Qt libraries on the test host."""
import ast
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1]


class QtNamespaceContractTests(unittest.TestCase):
    def test_tk_namespace_exports_every_attribute_used_by_application(self):
        facade = ast.parse((SOURCE / 'qt_compat.py').read_text(encoding='utf-8'))
        namespace = next(node for node in facade.body
                         if isinstance(node, ast.ClassDef) and node.name == 'TkNamespace')
        exports = {target.id for node in namespace.body if isinstance(node, ast.Assign)
                   for target in node.targets if isinstance(target, ast.Name)}
        used = set()
        for path in SOURCE.glob('*.py'):
            if path.name == 'qt_compat.py':
                continue
            tree = ast.parse(path.read_text(encoding='utf-8'))
            used.update(node.attr for node in ast.walk(tree)
                        if isinstance(node, ast.Attribute)
                        and isinstance(node.value, ast.Name) and node.value.id == 'tk')
        self.assertIn('Checkbutton', used)
        self.assertEqual(used - exports, set(), 'Missing tk compatibility exports')


if __name__ == '__main__':
    unittest.main()
