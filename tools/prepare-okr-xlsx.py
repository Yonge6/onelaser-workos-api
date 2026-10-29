#!/usr/bin/env python3
"""Prepare a private OKR import manifest from a DingTalk Excel export.

Reads only the named month's worksheet. Identity mappings are explicit inputs;
display names are never used to discover or create employees. No network calls.
"""
import argparse
import hashlib
import json
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


def extract_rows(path, sheet_name):
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
        result = []
        for row in sheet.findall(".//s:sheetData/s:row", NS):
            values = {}
            for cell in row.findall("s:c", NS):
                column = re.sub(r"\d+$", "", cell.get("r", ""))
                if not re.fullmatch(r"[A-Z]+", column):
                    raise ValueError("Invalid cell address")
                value = cell.find("s:v", NS)
                raw = value.text if value is not None else None
                if cell.get("t") == "s" and raw is not None:
                    raw = strings[int(raw)]
                elif cell.get("t") == "inlineStr":
                    raw = "".join(t.text or "" for t in cell.findall(".//s:t", NS))
                values[column] = raw
            result.append(values)
        if not result:
            raise ValueError("Empty worksheet")
        columns = [chr(65 + i) for i in range(len(HEADERS))]
        if [result[0].get(c) for c in columns] != HEADERS or set(result[0]) - set(columns):
            raise ValueError("Unrecognized export headers; inspect the workbook before importing")
        if any(set(row) - set(columns) for row in result[1:]):
            raise ValueError("Unexpected data columns; inspect the workbook before importing")
        rows = [{name: row.get(col) for col, name in zip(columns, HEADERS)} for row in result[1:]
                if any(v not in (None, "") for v in row.values())]
        if len(rows) > 1000:
            raise ValueError("Worksheet exceeds 1000 records")
        return rows


def make_manifest(path, context):
    period = context["period"]
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", period):
        raise ValueError("Invalid period")
    rows = extract_rows(path, context["tableName"])
    identities = context["verifiedIdentities"]
    if len({m["sourceName"] for m in identities}) != len(identities):
        raise ValueError("Duplicate identity mappings")
    mapping = {m["sourceName"]: m["externalUserId"] for m in identities}
    records, keys = [], set()
    for row in rows:
        name, owner_name = row["员工Name"], row["OKR归属人"]
        if name not in mapping or (owner_name not in (None, "", name)):
            raise ValueError("Unmapped or inconsistent employee identity; do not guess")
        uid, label, parent = mapping[name], row["标题Item"], row["父记录"] or None
        if not isinstance(label, str) or not re.fullmatch(r"(?:O|KR)\d+", label):
            raise ValueError("Unsupported O/KR item label")
        kind = "key_result" if label.startswith("KR") else "objective"
        if (kind == "objective" and parent) or (kind == "key_result" and not parent):
            raise ValueError("Invalid O/KR parent relationship")
        if parent and not re.fullmatch(r"O\d+", parent):
            raise ValueError("KR parent must identify an objective")
        source_key = uid + ":" + (parent + ":" if parent else "") + label
        if source_key in keys:
            raise ValueError("Duplicate employee/parent/item key; source row IDs required")
        keys.add(source_key)
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
    if any(r["parentSourceKey"] and r["parentSourceKey"] not in keys for r in records):
        raise ValueError("Parent objective missing from export")
    return {"version": 1, "source": {"provider": "dingtalk", "corpId": context["corpId"],
            "documentId": context["documentId"], "tableId": context["tableName"],
            "period": period, "url": context["url"],
            "exportedAt": context.get("exportedAt") or datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
            "snapshotSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "rowIdStrategy": "verified-identity-parent-item"}, "records": records}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("xlsx", type=Path)
    parser.add_argument("--context", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest = make_manifest(args.xlsx, json.loads(args.context.read_text(encoding="utf-8")))
    # Refuse replacement so every source snapshot is retained.
    with args.output.open("x", encoding="utf-8") as out:
        json.dump(manifest, out, ensure_ascii=False, indent=2)
        out.write("\n")
    args.output.chmod(0o600)
    print(json.dumps({"records": len(manifest["records"]),
                      "employees": len({r["ownerExternalUserId"] for r in manifest["records"]}),
                      "objectives": sum(r["kind"] == "objective" for r in manifest["records"]),
                      "keyResults": sum(r["kind"] == "key_result" for r in manifest["records"]),
                      "snapshotSha256": manifest["source"]["snapshotSha256"]}))


if __name__ == "__main__":
    main()
