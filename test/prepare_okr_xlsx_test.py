import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

spec = importlib.util.spec_from_file_location("prepare_okr", Path(__file__).parents[1] / "tools/prepare-okr-xlsx.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class ExportTests(unittest.TestCase):
    def workbook(self, path, rows, extra_xml=''):
        data = [tool.HEADERS] + rows
        sheet = '<worksheet xmlns="' + tool.NS['s'] + '"><sheetData>'
        for index, row in enumerate(data, 1):
            sheet += '<row r="%s">' % index
            for col, value in enumerate(row):
                address = chr(65 + col) + str(index)
                sheet += ('<c r="%s"/>' % address) if value is None else '<c r="%s" t="inlineStr"><is><t>%s</t></is></c>' % (address, escape(value))
            sheet += '</row>'
        sheet += '</sheetData>' + extra_xml + '</worksheet>'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('xl/workbook.xml', '<workbook xmlns="' + tool.NS['s'] + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="2026-10 OKR记录" r:id="rId1"/></sheets></workbook>')
            z.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
            z.writestr('xl/worksheets/sheet1.xml', sheet)

    def context(self):
        return {'period': '2026-10', 'tableName': '2026-10 OKR记录', 'corpId': 'test-corp',
                'documentId': 'test-document', 'url': 'https://alidocs.dingtalk.com/example',
                'verifiedIdentities': [{'sourceName': 'Fictional Employee', 'externalUserId': 'verified-123'}]}

    def row(self, label='O1', parent=None):
        return [label, 'Fictional Employee', '100%', 'Test location', 'Keep  double space',
                '基础任务Mandatory Task', '', None, '', None, None, None, '0', '0.00', parent,
                'Fictional Employee', '2026-08-27']

    def run_manifest(self, rows, context=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'export.xlsx'
            self.workbook(path, rows)
            return tool.make_manifest(path, context or self.context())

    def test_preserves_null_blank_formula_zero_and_old_date(self):
        result = self.run_manifest([self.row(), self.row('KR1', 'O1')])
        objective, kr = result['records']
        self.assertEqual(kr['parentSourceKey'], objective['sourceKey'])
        self.assertEqual(kr['planning']['weight'], 100)
        self.assertIsNone(kr['metrics'])
        self.assertEqual(kr['planning']['scoringDueDate'], '2026-08-27')
        raw = {f['name']: f['value'] for f in kr['rawFields']}
        self.assertIsNone(raw['员工评分Self-evaluation'])
        self.assertEqual(raw['KR成果显示 Show your KR here'], '')
        self.assertEqual(raw['KR得分 KR Score'], '0')
        self.assertEqual(kr['title'], 'Keep  double space')

    def test_does_not_guess_employee_identity(self):
        context = self.context()
        context['verifiedIdentities'] = []
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.run_manifest([self.row()], context)

    def test_duplicate_item_requires_better_source_identity(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate employee'):
            self.run_manifest([self.row(), self.row()])

    def test_orphan_kr_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Parent objective missing'):
            self.run_manifest([self.row('KR1', 'O2')])

    def test_unknown_type_rejected_without_conversion(self):
        row = self.row()
        row[5] = 'Unknown type'
        with self.assertRaisesRegex(ValueError, 'Unknown objective type'):
            self.run_manifest([row])

    def test_evidence_hyperlinks_are_not_silently_discarded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'export.xlsx'
            self.workbook(path, [self.row()], '<hyperlinks><hyperlink ref="I2" location="evidence"/></hyperlinks>')
            with self.assertRaisesRegex(ValueError, 'hyperlinks or embedded artifacts'):
                tool.make_manifest(path, self.context())


if __name__ == '__main__':
    unittest.main()
