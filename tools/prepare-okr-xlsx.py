#!/usr/bin/env python3
"""Prepare a private OKR import manifest from a DingTalk Excel export.

Reads only the named month's worksheet. Identity mappings are explicit inputs;
display names are never used to discover or create employees. No network calls.
"""
import argparse
import hashlib
import json
import os
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
import xml.etree.ElementTree as ET

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
HEADERS = ["标题Item", "员工Name", "权重Weighting", "工作地点Work Location",
           "描述Description", "O类型 Type", "是否奖励任务参与评分",
           "员工评分Self-evaluation", "KR成果显示 Show your KR here", "评分阐述Self-comment",
           "主管评分Mgr-evaluation", "评分阐述Mgr comment", "KR得分 KR Score",
           "OKR综合得分 OKR Sub-Score", "父记录", "OKR归属人", "打分截止日期"]


def extract_indexed_rows(path, sheet_name):
    with zipfile.ZipFile(path) as archive:
        if sum(i.file_size for i in archive.infolist()) > 30_000_000:
            raise ValueError("Workbook exceeds the 30 MB uncompressed limit")
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheets = [s for s in workbook.findall("s:sheets/s:sheet", NS) if s.get("name") == sheet_name]
        if len(sheets) != 1:
            raise ValueError("Expected exactly one matching monthly worksheet")
        rel_id = sheets[0].get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = [r.get("Target") for r in rels if r.get("Id") == rel_id and r.get("TargetMode") != "External"]
        if len(targets) != 1 or ".." in targets[0]:
            raise ValueError("Invalid worksheet relationship")
        target = targets[0].lstrip("/")
        if not target.startswith("xl/"):
            target = "xl/" + target
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = ["".join(t.text or "" for t in si.iter("{" + NS["s"] + "}t"))
                       for si in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("s:si", NS)]
        sheet = ET.fromstring(archive.read(target))
        # Do not silently discard named evidence links or embedded artifacts.
        # Such exports need a richer source capture before an import is safe.
        if any(sheet.find("s:" + name, NS) is not None
               for name in ("hyperlinks", "drawing", "legacyDrawing", "oleObjects")):
            raise ValueError("Workbook contains hyperlinks or embedded artifacts; preserve their targets before importing")
        if sheet.find(".//s:f", NS) is not None:
            raise ValueError("Workbook contains live formulas; preserve formula text and cached results before importing")
        result, row_numbers = [], set()
        for row in sheet.findall(".//s:sheetData/s:row", NS):
            number_text = row.get("r", "")
            if not re.fullmatch(r"[1-9]\d*", number_text):
                raise ValueError("Missing or invalid Excel row number")
            number = int(number_text)
            if number in row_numbers:
                raise ValueError("Duplicate Excel row number")
            row_numbers.add(number)
            values = {}
            for cell in row.findall("s:c", NS):
                address = re.fullmatch(r"([A-Z]+)([1-9]\d*)", cell.get("r", ""))
                if not address or int(address[2]) != number:
                    raise ValueError("Invalid cell address")
                column = address[1]
                if column in values:
                    raise ValueError("Duplicate cell address")
                value = cell.find("s:v", NS)
                raw = value.text if value is not None else None
                if cell.get("t") == "s" and raw is not None:
                    raw = strings[int(raw)]
                elif cell.get("t") == "inlineStr":
                    raw = "".join(t.text or "" for t in cell.findall(".//s:t", NS))
                values[column] = raw
            result.append((number, values))
        if not result:
            raise ValueError("Empty worksheet")
        columns = [chr(65 + i) for i in range(len(HEADERS))]
        if [result[0][1].get(c) for c in columns] != HEADERS or set(result[0][1]) - set(columns):
            raise ValueError("Unrecognized export headers; inspect the workbook before importing")
        if any(set(row) - set(columns) for _, row in result[1:]):
            raise ValueError("Unexpected data columns; inspect the workbook before importing")
        rows = [(number, {name: row.get(col) for col, name in zip(columns, HEADERS)})
                for number, row in result[1:]]
        if len(rows) > 1000:
            raise ValueError("Worksheet exceeds 1000 records")
        return rows


def extract_rows(path, sheet_name):
    """Compatibility view; preparation itself accounts for every physical row."""
    return [row for _, row in extract_indexed_rows(path, sheet_name)
            if any(v not in (None, "") for v in row.values())]


def raw_row_sha256(row):
    encoded = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class PreparationError(ValueError):
    def __init__(self, message, report):
        super().__init__(message)
        self.report = report


def _nonempty_text(value, maximum=300):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum


def _verified_mappings(identities):
    mapping = {}
    for identity in identities:
        name, uid = identity.get("sourceName"), identity.get("externalUserId")
        if not _nonempty_text(name) or not _nonempty_text(uid, 128) or name in mapping:
            raise ValueError("Invalid or duplicate identity mappings")
        owners = identity.get("sourceOwnerNames", [])
        if (not isinstance(owners, list) or any(not _nonempty_text(n) for n in owners)
                or len(set(owners)) != len(owners)):
            raise ValueError("Invalid exact source owner names")
        mapping[name] = {"uid": uid, "owners": {None, "", name, *owners}}
    return mapping


def _reviewed_rows(context, indexed_rows):
    reviews = context.get("reviewedRows", [])
    if not isinstance(reviews, list):
        raise ValueError("reviewedRows must be an array")
    source_rows = dict(indexed_rows)
    result = {}
    allowed = {"excelRowNumber", "expectedRawRowSha256", "reason", "action",
               "sourceKeyOverride", "attachToSourceKey"}
    for review in reviews:
        if not isinstance(review, dict) or set(review) - allowed:
            raise ValueError("Unknown reviewed row fields")
        number, expected = review.get("excelRowNumber"), review.get("expectedRawRowSha256")
        if type(number) is not int or number not in source_rows or number in result:
            raise ValueError("Reviewed Excel row missing or duplicated")
        if (not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected)
                or raw_row_sha256(source_rows[number]) != expected):
            raise ValueError("Reviewed raw row SHA256 mismatch")
        if not _nonempty_text(review.get("reason"), 20000):
            raise ValueError("Reviewed rows require a reason")
        if review.get("action") not in (None, "skip_empty"):
            raise ValueError("Unknown reviewed row action")
        operations = [review.get("action") == "skip_empty", "sourceKeyOverride" in review,
                      "attachToSourceKey" in review]
        if sum(operations) != 1:
            raise ValueError("Reviewed rows require exactly one operation")
        for field in ("sourceKeyOverride", "attachToSourceKey"):
            if field in review and not _nonempty_text(review[field]):
                raise ValueError("Invalid reviewed source key")
        result[number] = review
    return result


def _can_skip_empty(row):
    # A scored/submitted row must never disappear just because its title is empty.
    blank_fields = ["标题Item", "描述Description", "权重Weighting", "工作地点Work Location",
                    "O类型 Type", "员工评分Self-evaluation", "KR成果显示 Show your KR here",
                    "评分阐述Self-comment", "主管评分Mgr-evaluation", "评分阐述Mgr comment"]
    if any(row[name] not in (None, "") for name in blank_fields):
        return False
    if row["是否奖励任务参与评分"] not in (None, "", "FALSE", "false"):
        return False
    for name in ("KR得分 KR Score", "OKR综合得分 OKR Sub-Score"):
        value = row[name]
        if value not in (None, "") and (not isinstance(value, str) or not re.fullmatch(r"0(?:\.0+)?", value)):
            return False
    return True


def make_manifest_with_report(path, context):
    indexed_rows = extract_indexed_rows(path, context["tableName"])
    snapshot = hashlib.sha256(path.read_bytes()).hexdigest()
    report = {"version": 1, "status": "pending", "snapshotSha256": snapshot,
              "tableName": context["tableName"], "rows": {
                  str(number): {"excelRowNumber": number, "sourceName": row["员工Name"],
                                "sourceOwnerName": row["OKR归属人"], "rawFields": row,
                                "rawRowSha256": raw_row_sha256(row), "decision": "pending"}
                  for number, row in indexed_rows}}
    try:
        manifest = _prepare_manifest(path, context, indexed_rows, report, snapshot)
    except ValueError as error:
        report.update({"status": "rejected", "error": str(error)})
        raise PreparationError(str(error), report) from error
    report.update({"status": "prepared", "counts": {
        "sourceRows": len(indexed_rows), "records": len(manifest["records"]),
        "skippedEmpty": sum(r["decision"] == "skip_empty" for r in report["rows"].values()),
        "attached": sum(r["decision"] == "attach" for r in report["rows"].values()),
        "sourceKeyOverrides": sum("sourceKeyOverride" in r.get("review", {}) for r in report["rows"].values())}})
    return manifest, report


def make_manifest(path, context):
    return make_manifest_with_report(path, context)[0]


def _prepare_manifest(path, context, indexed_rows, report, snapshot):
    period = context["period"]
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", period):
        raise ValueError("Invalid period")
    mapping = _verified_mappings(context["verifiedIdentities"])
    reviews = _reviewed_rows(context, indexed_rows)
    records, keys, attachments = [], set(), []
    objective_keys = {}
    for number, row in indexed_rows:
        entry, review = report["rows"][str(number)], reviews.get(number, {})
        if review:
            entry["review"] = review
        if review.get("action") == "skip_empty":
            if not _can_skip_empty(row):
                raise ValueError("skip_empty row contains planning, results, or evaluation content")
            entry["decision"] = "skip_empty"
            continue
        name, owner_name = row["员工Name"], row["OKR归属人"]
        if name not in mapping or owner_name not in mapping[name]["owners"]:
            raise ValueError("Unmapped or inconsistent employee identity; do not guess")
        uid, label, parent = mapping[name]["uid"], row["标题Item"], row["父记录"] or None
        if "attachToSourceKey" in review:
            if label not in (None, "") or not row["描述Description"]:
                raise ValueError("Only untitled substantive source rows may be attached")
            attachments.append((number, row, uid, review["attachToSourceKey"]))
            continue
        if not isinstance(label, str) or not re.fullmatch(r"(?:O|KR)\d+", label):
            raise ValueError("Unsupported O/KR item label")
        kind = "key_result" if label.startswith("KR") else "objective"
        if (kind == "objective" and parent) or (kind == "key_result" and not parent):
            raise ValueError("Invalid O/KR parent relationship")
        if parent and not re.fullmatch(r"O\d+", parent):
            raise ValueError("KR parent must identify an objective")
        default_key = uid + ":" + (parent + ":" if parent else "") + label
        source_key = review.get("sourceKeyOverride", default_key)
        if not _nonempty_text(source_key):
            raise ValueError("Invalid generated source key")
        if source_key in keys:
            raise ValueError("Duplicate employee/parent/item key; source row IDs required")
        keys.add(source_key)
        if kind == "objective":
            objective_keys.setdefault((uid, label), []).append(source_key)
        raw_weight = row["权重Weighting"]
        if raw_weight in (None, ""):
            weight = None
        elif re.fullmatch(r"\d+(?:\.\d+)?%", raw_weight):
            weight = float(raw_weight[:-1])
        else:
            raise ValueError("Unrecognized weight format")
        raw_type = row["O类型 Type"]
        types = {"基础任务Mandatory Task": "mandatory", "奖励任务Bonus Task": "bonus", None: None, "": None}
        if raw_type not in types:
            raise ValueError("Unknown objective type")
        bonus = row["是否奖励任务参与评分"]
        bonus_values = {None: None, "": None, "FALSE": False, "TRUE": True, "false": False, "true": True}
        if bonus not in bonus_values:
            raise ValueError("Unknown bonus formula value")
        deadline = row["打分截止日期"] or None
        if deadline:
            datetime.strptime(deadline, "%Y-%m-%d")
        description = row["描述Description"]
        if not description:
            raise ValueError("Missing description; cannot invent an objective title")
        planning = {"weight": weight, "description": description, "scoringDueDate": deadline}
        if kind == "objective":
            planning.update({"location": row["工作地点Work Location"], "type": types[raw_type],
                             "bonusIncluded": bonus_values[bonus]})
        records.append({"sourceKey": source_key, "kind": kind,
                        "parentSourceKey": uid + ":" + parent if parent else None,
                        "ownerExternalUserId": uid, "itemLabel": label, "title": description,
                        "planning": planning,
                        "metrics": None,
                        "rawFields": [{"name": name, "value": row[name]} for name in HEADERS]})
        entry.update({"decision": "import", "sourceKey": source_key, "defaultSourceKey": default_key})
    for record in records:
        if record["kind"] != "key_result":
            continue
        parent_label = next(f["value"] for f in record["rawFields"] if f["name"] == "父记录")
        candidates = objective_keys.get((record["ownerExternalUserId"], parent_label), [])
        if not candidates:
            raise ValueError("Parent objective missing from export")
        if len(candidates) != 1:
            raise ValueError("Parent objective label is ambiguous; review source hierarchy")
        record["parentSourceKey"] = candidates[0]
    by_key = {record["sourceKey"]: record for record in records}
    for number, row, uid, target_key in attachments:
        target = by_key.get(target_key)
        if (not target or target["kind"] != "key_result" or target["ownerExternalUserId"] != uid
                or row["父记录"] != target["itemLabel"]):
            raise ValueError("Attachment parent missing, inconsistent, or not a same-owner KR")
        field_name = "原表子记录 · Excel行" + str(number)
        if len(target["rawFields"]) >= 100 or any(f["name"] == field_name for f in target["rawFields"]):
            raise ValueError("Attachment raw field conflicts or exceeds the manifest limit")
        target["rawFields"].append({"name": field_name, "value": dict(row)})
        report["rows"][str(number)].update({"decision": "attach", "attachToSourceKey": target_key})
    if not records:
        raise ValueError("No importable O/KR records")
    return {"version": 1, "source": {"provider": "dingtalk", "corpId": context["corpId"],
            "documentId": context["documentId"], "tableId": context["tableName"],
            "period": period, "url": context["url"],
            "exportedAt": context.get("exportedAt") or datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
            "snapshotSha256": snapshot,
            "rowIdStrategy": "verified-identity-parent-item"}, "records": records}


def _write_private_json(path, value):
    # Apply private permissions at creation, before any employee data is written.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as out:
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("xlsx", type=Path)
    parser.add_argument("--context", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", type=Path, help="Private row-by-row audit report; defaults to OUTPUT.report.json")
    args = parser.parse_args()
    report_path = args.report or Path(str(args.output) + ".report.json")
    if (args.output.resolve() == report_path.resolve() or args.output.exists() or report_path.exists()
            or {args.output.resolve(), report_path.resolve()} & {args.xlsx.resolve(), args.context.resolve()}):
        parser.error("Output/report must be distinct new private files; refusing replacement")
    try:
        manifest, report = make_manifest_with_report(args.xlsx, json.loads(args.context.read_text(encoding="utf-8")))
    except PreparationError as error:
        _write_private_json(report_path, error.report)
        parser.exit(2, "Preparation rejected; inspect the private row report.\n")
    _write_private_json(report_path, report)
    _write_private_json(args.output, manifest)
    print(json.dumps({"records": len(manifest["records"]),
                      "employees": len({r["ownerExternalUserId"] for r in manifest["records"]}),
                      "objectives": sum(r["kind"] == "objective" for r in manifest["records"]),
                      "keyResults": sum(r["kind"] == "key_result" for r in manifest["records"]),
                      "snapshotSha256": manifest["source"]["snapshotSha256"]}))


if __name__ == "__main__":
    main()
