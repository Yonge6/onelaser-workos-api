import importlib.util
import hashlib
import json
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

spec = importlib.util.spec_from_file_location("prepare_okr", Path(__file__).parents[1] / "tools/prepare-okr-xlsx.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class ExportTests(unittest.TestCase):
    def workbook(self, path, rows, extra_xml='', row_numbers=None):
        data = [tool.HEADERS] + rows
        sheet = '<worksheet xmlns="' + tool.NS['s'] + '"><sheetData>'
        numbers = [1] + (row_numbers if row_numbers is not None else list(range(2, len(data) + 1)))
        for index, row in zip(numbers, data):
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

    def review(self, row, number=2, **operation):
        return {'excelRowNumber': number, 'expectedRawRowSha256': tool.raw_row_sha256(dict(zip(tool.HEADERS, row))),
                'reason': 'Independently checked against the original hierarchy', **operation}

    def child_row(self, parent='KR1'):
        row = self.row(None, parent)
        row[4], row[9] = 'Original child task', 'https://example.com/original-evidence'
        return row

    def placeholder(self):
        row = [None] * len(tool.HEADERS)
        row[12], row[13], row[14], row[16] = '0', '0.00', 'KR1', '2026-08-03'
        return row

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

    def test_exact_owner_alias_is_explicit_and_raw_multi_owner_is_preserved(self):
        row, context = self.row(), self.context()
        row[15] = 'Verified Alias,Other Original Owner'
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.run_manifest([row], context)
        context['verifiedIdentities'][0]['sourceOwnerNames'] = [row[15]]
        record = self.run_manifest([row], context)['records'][0]
        self.assertEqual(record['ownerExternalUserId'], 'verified-123')
        self.assertEqual(record['rawFields'][15]['value'], row[15])
        row[15] = 'Verified Alias, Other Original Owner'
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.run_manifest([row], context)

    def test_owner_alias_does_not_map_an_unverified_employee(self):
        row, context = self.row(), self.context()
        context['verifiedIdentities'][0]['sourceOwnerNames'] = ['Unverified Employee']
        row[1], row[15] = 'Unverified Employee', 'Unverified Employee'
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.run_manifest([row], context)

    def test_raw_hash_is_canonical_unicode_json_without_normalization(self):
        row = {'z': None, '中文': '  原文  ', 'a': ''}
        expected = hashlib.sha256('{"a":"","z":null,"中文":"  原文  "}'.encode('utf-8')).hexdigest()
        self.assertEqual(tool.raw_row_sha256(row), expected)
        self.assertEqual(tool.raw_row_sha256(dict(reversed(list(row.items())))), expected)

    def test_review_uses_physical_excel_row_numbers_and_keeps_report_for_every_row(self):
        rows, context = [self.row(), self.row()], self.context()
        context['reviewedRows'] = [self.review(rows[1], 20, sourceKeyOverride='reviewed:second-O1')]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'export.xlsx'
            self.workbook(path, rows, row_numbers=[7, 20])
            manifest, report = tool.make_manifest_with_report(path, context)
            self.assertEqual(set(report['rows']), {'7', '20'})
            self.assertEqual(report['rows']['20']['rawFields'], dict(zip(tool.HEADERS, rows[1])))
            self.assertEqual(manifest['records'][1]['itemLabel'], 'O1')
            self.assertEqual(manifest['records'][1]['sourceKey'], 'reviewed:second-O1')
            self.assertEqual(report['counts']['sourceKeyOverrides'], 1)
            context['reviewedRows'][0]['excelRowNumber'] = 3
            with self.assertRaisesRegex(ValueError, 'row missing'):
                tool.make_manifest(path, context)

    def test_changed_raw_cell_invalidates_review_and_returns_full_rejection_report(self):
        row, context = self.row(), self.context()
        context['reviewedRows'] = [self.review(row, sourceKeyOverride='reviewed:source')]
        row[9] = 'New content after review'
        with self.assertRaises(tool.PreparationError) as raised:
            self.run_manifest([row, self.row('O2')], context)
        self.assertIn('SHA256 mismatch', str(raised.exception))
        report = raised.exception.report
        self.assertEqual(report['status'], 'rejected')
        self.assertEqual(len(report['rows']), 2)
        self.assertEqual(report['rows']['2']['rawFields']['评分阐述Self-comment'], row[9])

    def test_review_rejects_duplicate_unknown_or_conflicting_operations(self):
        row = self.row()
        review = self.review(row, sourceKeyOverride='reviewed:source')
        cases = [[review, review], [{**review, 'extra': True}],
                 [{**review, 'attachToSourceKey': 'verified-123:O1:KR1'}],
                 [{**review, 'action': 'skip_empty'}], [{**review, 'reason': ''}]]
        for reviews in cases:
            with self.subTest(reviews=reviews):
                context = self.context()
                context['reviewedRows'] = reviews
                with self.assertRaises(ValueError):
                    self.run_manifest([row], context)

    def test_overrides_cannot_collide_or_hide_ambiguous_parent_objectives(self):
        rows, context = [self.row(), self.row()], self.context()
        context['reviewedRows'] = [self.review(rows[1], 3, sourceKeyOverride='verified-123:O1')]
        with self.assertRaisesRegex(ValueError, 'Duplicate employee'):
            self.run_manifest(rows, context)
        context['reviewedRows'][0]['sourceKeyOverride'] = 'reviewed:second-objective'
        with self.assertRaisesRegex(ValueError, 'Parent objective label is ambiguous'):
            self.run_manifest(rows + [self.row('KR1', 'O1')], context)

    def test_unique_overridden_objective_keeps_its_children_connected(self):
        rows, context = [self.row(), self.row('KR1', 'O1')], self.context()
        context['reviewedRows'] = [self.review(rows[0], sourceKeyOverride='reviewed:objective')]
        records = self.run_manifest(rows, context)['records']
        self.assertEqual(records[1]['parentSourceKey'], 'reviewed:objective')
        self.assertEqual(records[1]['sourceKey'], 'verified-123:O1:KR1')

    def test_skip_empty_is_explicit_and_preserves_full_private_row(self):
        empty, context = self.placeholder(), self.context()
        with self.assertRaises(ValueError):
            self.run_manifest([self.row(), empty])
        context['reviewedRows'] = [self.review(empty, 3, action='skip_empty')]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'export.xlsx'
            self.workbook(path, [self.row(), empty])
            manifest, report = tool.make_manifest_with_report(path, context)
        self.assertEqual(len(manifest['records']), 1)
        self.assertEqual(report['counts']['skippedEmpty'], 1)
        self.assertEqual(report['rows']['3']['rawFields'], dict(zip(tool.HEADERS, empty)))

    def test_skip_empty_cannot_discard_labels_plans_results_or_even_zero_appraisals(self):
        cases = {0: 'KR1', 2: '0%', 3: 'Location', 4: 'Substantive description',
                 5: '基础任务Mandatory Task', 6: 'TRUE', 7: '0', 8: 'https://example.com/result',
                 9: 'Self comment', 10: '0', 11: 'Manager comment', 12: '0.1', 13: '-0.0'}
        for field, value in cases.items():
            with self.subTest(field=field):
                empty, context = self.placeholder(), self.context()
                empty[field] = value
                context['reviewedRows'] = [self.review(empty, 3, action='skip_empty')]
                with self.assertRaisesRegex(ValueError, 'skip_empty row contains'):
                    self.run_manifest([self.row(), empty], context)

    def test_physical_all_blank_row_requires_review_too(self):
        with self.assertRaises(ValueError):
            self.run_manifest([self.row(), [None] * len(tool.HEADERS)])

    def test_attachment_preserves_17_raw_fields_without_inventing_records_or_metrics(self):
        rows = [self.row(), self.row('KR1', 'O1'), self.child_row(), self.child_row()]
        context = self.context()
        context['reviewedRows'] = [self.review(row, number, attachToSourceKey='verified-123:O1:KR1')
                                   for number, row in enumerate(rows[2:], 4)]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'export.xlsx'
            self.workbook(path, rows)
            manifest, report = tool.make_manifest_with_report(path, context)
        self.assertEqual(len(manifest['records']), 2)
        kr = manifest['records'][1]
        self.assertIsNone(kr['metrics'])
        self.assertEqual(len(kr['rawFields']), 19)
        self.assertEqual(kr['rawFields'][17], {'name': '原表子记录 · Excel行4',
                                             'value': dict(zip(tool.HEADERS, rows[2]))})
        self.assertEqual(report['rows']['4']['decision'], 'attach')
        self.assertEqual(report['counts']['attached'], 2)

    def test_attachment_rejects_labeled_empty_missing_wrong_owner_or_wrong_label_parent(self):
        for case in ('labeled', 'empty', 'missing', 'objective', 'wrong-owner', 'wrong-label', 'chain'):
            with self.subTest(case=case):
                child, context = self.child_row(), self.context()
                target = 'verified-123:O1:KR1'
                if case == 'labeled':
                    child[0] = 'KR2'
                if case == 'empty':
                    child[4] = ''
                if case == 'missing':
                    target = 'missing:parent'
                if case == 'objective':
                    target, child[14] = 'verified-123:O1', 'O1'
                if case == 'wrong-owner':
                    context['verifiedIdentities'].append({'sourceName': 'Other', 'externalUserId': 'other-id'})
                    child[1], child[15] = 'Other', 'Other'
                if case == 'wrong-label':
                    child[14] = 'KR2'
                if case == 'chain':
                    target = '原表子记录 · Excel行4'
                context['reviewedRows'] = [self.review(child, 4, attachToSourceKey=target)]
                with self.assertRaises(ValueError):
                    self.run_manifest([self.row(), self.row('KR1', 'O1'), child], context)

    def test_new_review_context_does_not_change_unreviewed_legacy_record_payloads(self):
        rows = [self.row(), self.row('KR1', 'O1')]
        baseline = self.run_manifest(rows)
        context = self.context()
        context['verifiedIdentities'][0]['sourceOwnerNames'] = ['Additional approved spelling']
        context['reviewedRows'] = []
        updated = self.run_manifest(rows, context)
        self.assertEqual(updated['records'], baseline['records'])
        self.assertEqual(updated['source']['rowIdStrategy'], 'verified-identity-parent-item')
        # Golden value captured independently from the pre-review implementation.
        encoded = json.dumps(updated['records'], sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        self.assertEqual(hashlib.sha256(encoded.encode('utf-8')).hexdigest(),
                         '34f7d0785c274192c550430e5f142f8ee31b46769fba56f3412405f16f372efa')

    def test_attachment_obeys_raw_field_schema_limit(self):
        rows = [self.row(), self.row('KR1', 'O1')] + [self.child_row() for _ in range(84)]
        context = self.context()
        context['reviewedRows'] = [self.review(row, number, attachToSourceKey='verified-123:O1:KR1')
                                   for number, row in enumerate(rows[2:], 4)]
        with self.assertRaisesRegex(ValueError, 'manifest limit'):
            self.run_manifest(rows, context)
        rows.pop()
        context['reviewedRows'].pop()
        self.assertEqual(len(self.run_manifest(rows, context)['records'][1]['rawFields']), 100)

    def test_duplicated_physical_excel_row_numbers_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'export.xlsx'
            self.workbook(path, [self.row(), self.row('O2')], row_numbers=[7, 7])
            with self.assertRaisesRegex(ValueError, 'Duplicate Excel row number'):
                tool.make_manifest(path, self.context())

    def test_cli_writes_private_report_without_employee_data_on_stdout_and_refuses_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            xlsx, context, output = folder / 'export.xlsx', folder / 'context.json', folder / 'manifest.json'
            self.workbook(xlsx, [self.row()])
            context.write_text(json.dumps(self.context()), encoding='utf-8')
            command = [sys.executable, str(Path(tool.__file__)), str(xlsx), '--context', str(context), '--output', str(output)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('Fictional', result.stdout + result.stderr)
            self.assertNotIn('Keep  double space', result.stdout + result.stderr)
            report = Path(str(output) + '.report.json')
            self.assertEqual(json.loads(report.read_text())['status'], 'prepared')
            for file in (report, output):
                self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
            original = output.read_bytes()
            repeat = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(repeat.returncode, 0)
            self.assertEqual(output.read_bytes(), original)

    def test_cli_rejection_writes_all_rows_to_private_report_and_no_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            xlsx, context, output = folder / 'export.xlsx', folder / 'context.json', folder / 'manifest.json'
            self.workbook(xlsx, [self.row(), self.row()])
            context.write_text(json.dumps(self.context()), encoding='utf-8')
            result = subprocess.run([sys.executable, str(Path(tool.__file__)), str(xlsx), '--context', str(context),
                                     '--output', str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(output.exists())
            self.assertNotIn('Fictional', result.stdout + result.stderr)
            report = json.loads(Path(str(output) + '.report.json').read_text())
            self.assertEqual(report['status'], 'rejected')
            self.assertEqual(len(report['rows']), 2)


if __name__ == '__main__':
    unittest.main()
