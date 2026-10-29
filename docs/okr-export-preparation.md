# DingTalk OKR export preparation / 钉钉 OKR 导出整理

Export the specific monthly table with its original fields. An advanced-permissions warning means the export may contain only the signed-in user's readable records. Record that coverage limitation; never describe it as an all-staff import without checking the full source scope.

在钉钉导出指定月份的数据表。高级权限可能限制可导出的人员范围，必须记录实际覆盖人数，不能把个人可见记录称为全员数据。

Keep the workbook, context, manifest, and import receipts in a private directory such as `.runtime/okr-import/2026-10/`. These files contain employee records and must not be committed to GitHub or placed in public frontend assets.

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

The parser preserves all 17 source fields, empty cells, text spacing, formula display values, original deadlines, and parent labels. It rejects unknown headers, unmapped people, duplicate keys, unknown types, and missing parents. It reads only the named monthly sheet and does not execute workbook formulas or follow links. Exports with Excel hyperlinks, embedded artifacts, or live formulas are rejected until their additional source data can be preserved; they are never silently reduced to cell display text.

导入整理保留 17 个原字段、空值、文本空格、公式显示值、原截止日期和父记录关系。无法识别的字段、人员、任务类型、重复条目或缺失父记录均停止处理，不自动补猜。

This export lacks native row IDs. Source keys therefore combine the explicitly verified employee ID, parent label, and item label. This supports a checked snapshot import and duplicate/conflict detection; it is not an incremental synchronization protocol. If labels or parent relationships change, manually reconcile the original source IDs before importing again.

此类导出没有原生记录 ID，使用已核实员工 ID、父记录标签和条目标签组合识别记录，只用于固定快照导入和重复/冲突检测。标签或层级变更后须人工核对，不应当作持续同步。

No numeric baseline, target, actual result, or new appraisal is inferred from prose or a formula's displayed zero. Original evaluations remain source history; they are separate from current employee submissions and manager-confirmed evaluations. Dates outside the selected period remain unchanged and are flagged for review.

不从文字或公式的 0 推断业务指标与成绩。原始评价作为来源历史保留，不冒充新提交的自评或主管核定；与周期不一致的日期只提示核对，不自动修改。
