# DingTalk OKR export preparation / 钉钉 OKR 导出整理

Export the specific monthly table with its original fields. An advanced-permissions warning means the export may contain only the signed-in user's readable records. Record that coverage limitation; never describe it as an all-staff import without checking the full source scope.

在钉钉导出指定月份的数据表。高级权限可能限制可导出的人员范围，必须记录实际覆盖人数，不能把个人可见记录称为全员数据。

Keep the workbook, context, manifest, row review report, and import receipts in a private directory such as `.runtime/okr-import/2026-10/`. These files contain employee records and must not be committed to GitHub or placed in public frontend assets.

原表、人员映射、导入清单和回执只保存到私有目录；不得提交公开仓库或放入前端静态资源。

Prepare a private context JSON using independently verified DingTalk identities:

```json
{
  "period": "2026-10",
  "tableName": "2026-10 OKR记录",
  "corpId": "verified-corp-id",
  "documentId": "verified-document-id",
  "url": "https://alidocs.dingtalk.com/i/nodes/verified-node-id",
  "verifiedIdentities": [
    {"sourceName": "Fictional Employee", "externalUserId": "verified-user-id"}
  ]
}
```

The external user ID is the DingTalk identity ID, not a staff/job number. The parser never discovers identities from display names. Each name-to-ID mapping must be verified before it is supplied.

钉钉用户 ID 不等于工号。人员显示名与用户 ID 的对应关系必须事先核实；导入程序不会凭姓名自动匹配或创建员工。

```sh
python3 tools/prepare-okr-xlsx.py \
  .runtime/okr-import/2026-10/export.xlsx \
  --context .runtime/okr-import/2026-10/context.json \
  --output .runtime/okr-import/2026-10/manifest.json
```

The CLI creates `manifest.json.report.json` alongside the manifest, or an explicitly supplied `--report` path. Both files are created with mode `0600`; neither may already exist, and neither may replace the workbook/context. Standard output contains only aggregate counts and the snapshot hash. A row-validation failure writes a private rejected report and no manifest. Workbook-format failures stop before row preparation and cannot produce a complete row report.

命令行默认同时生成 `manifest.json.report.json`，也可通过 `--report` 指定私有报告位置。文件创建时即使用 `0600` 权限，拒绝覆盖已有文件。控制台只输出数量和快照哈希；逐行验证失败时写入拒绝报告，不生成可导入清单。工作簿格式本身无法解析时不会伪造逐行报告。

The parser preserves all 17 source fields, empty cells, text spacing, formula display values, original deadlines, and parent labels. It rejects unknown headers, unmapped people, duplicate keys, unknown types, and missing parents. It reads only the named monthly sheet and does not execute workbook formulas or follow links. Exports with Excel hyperlinks, embedded artifacts, or live formulas are rejected until their additional source data can be preserved; they are never silently reduced to cell display text.

导入整理保留 17 个原字段、空值、文本空格、公式显示值、原截止日期和父记录关系。无法识别的字段、人员、任务类型、重复条目或缺失父记录均停止处理，不自动补猜。

This export lacks native row IDs. Source keys therefore combine the explicitly verified employee ID, parent label, and item label. This supports a checked snapshot import and duplicate/conflict detection; it is not an incremental synchronization protocol. If labels or parent relationships change, manually reconcile the original source IDs before importing again.

此类导出没有原生记录 ID，使用已核实员工 ID、父记录标签和条目标签组合识别记录，只用于固定快照导入和重复/冲突检测。标签或层级变更后须人工核对，不应当作持续同步。

## Explicit review context / 显式人工复核

There is no fuzzy name matching, row-order parent inference, automatic renumbering, or automatic dropping of blank rows. The optional context extensions below apply only to separately verified identities and individually reviewed source rows. They do not grant access, create employee accounts, or change department scope.

以下扩展只表达已经核实的人员映射和已经逐行复核的处理决定。程序不会模糊匹配、按行顺序猜父级、自动改编号或自动丢弃空行，也不会因此创建账号或扩大部门权限。

### Exact owner spelling / 原始归属人字符串

Each identity may provide `sourceOwnerNames`, an array of exact approved values for the entire `OKR归属人` cell:

```json
{
  "sourceName": "Fictional Employee-Display Alias",
  "externalUserId": "verified-user-id",
  "sourceOwnerNames": ["Fictional Employee", "Fictional Employee,Verified Collaborator"]
}
```

The primary identity still comes only from the exact `sourceName` → `externalUserId` mapping. Blank owner cells and the exact source name retain their existing behavior. Additional owner values require exact approval, including spaces, punctuation, and order. A multi-owner string is retained verbatim in the original raw fields; this approval does not split a record between users or grant a collaborator access. Resolve the operational primary owner separately before preparing context.

主身份仍然由 `sourceName` 与 `externalUserId` 明确指定。多位归属人的完整字符串必须逐字批准，原值完整保留；它不会被拆分成新账号、自动分摊目标或扩充访问权限。实际主负责人应先由人工确认。

### Row review guard / 行号与原始内容校验

`reviewedRows` is an optional array. Each entry requires:

- `excelRowNumber`: the actual worksheet row number, not the index in a filtered list.
- `expectedRawRowSha256`: lowercase SHA-256 of the complete original 17-field row dictionary.
- `reason`: a nonempty review explanation.
- Exactly one operation: `sourceKeyOverride`, `action: "skip_empty"`, or `attachToSourceKey`.

Unknown fields, duplicate/missing row references, conflicting operations, and stale hashes are rejected. The hash uses the unmodified source dictionary, before applying identities or operations:

```python
hashlib.sha256(json.dumps(
    row, sort_keys=True, ensure_ascii=False, separators=(",", ":")
).encode("utf-8")).hexdigest()
```

`extract_indexed_rows(path, table_name)` returns `(actual_excel_row_number, raw_row_dict)` pairs, including physical blank rows. `raw_row_sha256(row)` implements the hash above. `make_manifest_with_report(path, context)` returns `(manifest, report)`; `make_manifest` remains compatible and returns only the manifest. `report.rows` is keyed by the actual Excel row number as a string and includes every raw row, the unchanged source employee/owner strings, hash, and processing decision. On row rejection, `PreparationError.report` retains all source rows and the rejection reason; decisions made before the rejection are preparation-only, not imported records.

每条规则都绑定 Excel 实际行号和原始整行哈希。原表任何字段改变后，旧批准不能继续使用。报告按真实行号索引，保留所有原始行及处理决定；“已整理”不表示已写入生产数据库。

Example shape (replace the illustrative hashes with hashes computed from the reviewed export):

```json
{
  "reviewedRows": [
    {
      "excelRowNumber": 20,
      "expectedRawRowSha256": "<64 lowercase hexadecimal characters>",
      "reason": "Both original rows were checked; they are distinct records with the same displayed label.",
      "sourceKeyOverride": "verified-user-id:reviewed-migration:second-O5"
    },
    {
      "excelRowNumber": 21,
      "expectedRawRowSha256": "<64 lowercase hexadecimal characters>",
      "reason": "Empty placeholder checked against the original table.",
      "action": "skip_empty"
    },
    {
      "excelRowNumber": 22,
      "expectedRawRowSha256": "<64 lowercase hexadecimal characters>",
      "reason": "The original table hierarchy confirms this untitled row is a child of O6/KR3.",
      "attachToSourceKey": "verified-user-id:O6:KR3"
    }
  ]
}
```

### Duplicate labels / 重号

`sourceKeyOverride` is an explicit **migration key**, not a native DingTalk record ID. It leaves `itemLabel`, all 17 raw fields, and `source.rowIdStrategy` unchanged. Keep each chosen migration key stable in later checked snapshots. Duplicate resulting keys are rejected. A uniquely identified objective with an overridden key can retain its children; multiple same-owner objectives sharing a label still make a child's parent ambiguous and are rejected. Do not solve ambiguous parentage by arbitrarily overriding a sibling key.

迁移键不冒充原表记录 ID，不改变原始编号。后续固定快照须沿用已核实的键。若两个 O 仍同名且存在指向该标签的 KR，程序会拒绝父级歧义；不会因为其中一个换了键就擅自选择另一个。

### Empty placeholders / 空占位

`skip_empty` requires both item label and description to be empty, with no weight, location, task type, evidence, self/manager score, or comment. In particular, an explicitly entered appraisal of `0` is business data and cannot be skipped. Only blank/default false bonus values and blank/zero displayed formula values are allowed; identity, parent-label, and deadline metadata may remain. The entire row and review reason are kept in the private report. Any substantive row must be imported normally or resolved explicitly, never discarded as an empty placeholder.

空占位必须没有标题、描述及其他计划/成果/评价内容。人工评分 `0` 也是业务数据，不能当空值删除。默认公式显示 `0`、空值以及已有人员、父标签、日期元数据可以保留；完整行仍保存在私有报告中。

### Untitled child rows / 未命名子记录

`attachToSourceKey` is allowed only for an untitled row with a nonempty description. The target must be an existing, uniquely keyed KR of the same verified employee, and the original parent-label cell must equal that KR's unchanged `itemLabel`. Labeled rows, missing/cross-owner/non-KR parents, attachment chains, conflicting raw-field names, and raw-field limit overflows are rejected.

The complete original 17-field dictionary is appended to the parent KR's `rawFields` as a JSON value named `原表子记录 · Excel行N`. No new KR label, objective, metric, weight aggregation, or appraisal is invented. The attachment also remains in the private report. Adding an attachment changes the parent's source payload hash: if that parent was already imported, the normal API conflict guard must be respected; preparation does not authorize overwriting it.

子记录的 17 个原始字段作为父 KR 的 `rawFields` 中 `原表子记录 · Excel行N` 的 JSON 值保留，不虚构编号，不合并权重或评分。附加内容会改变父 KR 的来源哈希；若父记录已导入，必须遵守原有冲突保护，不能覆盖。未经修改的既有记录及旧版来源策略保持不变。

No numeric baseline, target, actual result, or new appraisal is inferred from prose or a formula's displayed zero. Original evaluations remain source history; they are separate from current employee submissions and manager-confirmed evaluations. Dates outside the selected period remain unchanged and are flagged for review.

不从文字或公式的 0 推断业务指标与成绩。原始评价作为来源历史保留，不冒充新提交的自评或主管核定；与周期不一致的日期只提示核对，不自动修改。
