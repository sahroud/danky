#!/usr/bin/env python3
"""Read public Digikala campaign announcements and publish code candidates.
Candidates are leads only: the app never claims a code is accepted until the user tests it.
"""
import html
import json
import os
import re
import urllib.request
from datetime import datetime, timezone

SOURCES = [
    ("Digikala official Telegram", "https://t.me/s/digikalaofficialaccount"),
    ("Digikala treasure hunt", "https://www.digikala.com/landings/prize-catcher/"),
]
CODE_RE = re.compile(r"\\bDK[A-Z0-9]{3,4}\\b", re.I)
HINT_RE = re.compile(r"جاکدی|جاکُدی|کد تخفیف|شکار گنج|prize.?catcher", re.I)
PERCENT_RE = re.compile(r"(\\d{1,3})\\s*٪|%\\s*(\\d{1,3})")

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def get_page(url):
    req = urllib.request.Request(url, headers={"User-Agent": "SAHROUD-DIGI-CODE/1.0 (public campaign monitor)"})
    with urllib.request.urlopen(req, timeout=20) as response:
        return response.read(3_000_000).decode("utf-8", "replace")

def plain(text):
    text = re.sub(r"(?is)<(script|style).*?>.*?</\\1>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return re.sub(r"\\s+", " ", html.unescape(text))

def main():
    checked_at = now_iso()
    found = {}
    errors = []
    try:
        with open("digicode/candidates.json", encoding="utf-8") as f:
            previous = json.load(f)
    except Exception:
        previous = {}
    previous_by_code = {x.get("code"): x for x in previous.get("candidates", []) if x.get("code")}
    for label, url in SOURCES:
        try:
            raw = get_page(url)
            for match in CODE_RE.finditer(raw):
                start, end = max(0, match.start()-500), min(len(raw), match.end()+500)
                snippet = plain(raw[start:end])
                if not HINT_RE.search(snippet):
                    continue
                code = match.group(0).upper()
                percentages = [int(a or b) for a, b in PERCENT_RE.findall(snippet)]
                discount = max((p for p in percentages if 0 < p <= 100), default=None)
                found[code] = {
                    "code": code,
                    "source_name": label,
                    "source_url": url,
                    "discount_percent": discount,
                    "status": "سرنخ از منبع عمومی؛ پذیرش در حساب دیجی‌کالا هنوز آزمایش نشده",
                    "seen_at": previous_by_code.get(code, {}).get("seen_at") or checked_at,
                    "excerpt": snippet[:420],
                }
        except Exception as exc:
            errors.append({"source": label, "error": str(exc)[:240]})
    if not found and errors and previous_by_code:
        found = {code: {**item, "status": "نتیجه قبلی؛ این نوبت منبع قابل بررسی نبود", "discount_percent": None} for code, item in previous_by_code.items()}

    candidates = sorted(found.values(), key=lambda x: (x["discount_percent"] or 0), reverse=True)
    # Compare actual candidate data, not just code names, so changed snippets/discounts are published.
    def comparable(items):
        return sorted([
            {k: item.get(k) for k in ("code", "source_name", "source_url", "discount_percent", "status", "excerpt")}
            for item in items
        ], key=lambda x: x["code"] or "")
    data_changed = comparable(candidates) != comparable(previous.get("candidates", [])) or previous.get("source_errors", []) != errors
    output = {
        "updated_at": now_iso() if data_changed or not previous.get("updated_at") else previous["updated_at"],
        "monitor_status": "ok" if found or not errors else "partial",
        "notice": "کاندیداها سرنخ هستند؛ اعتبار و مقدار تخفیف فقط با آزمایش در جاکدی/صفحه رسمی مشخص می‌شود.",
        "candidates": candidates,
        "source_errors": errors,
    }
    with open("digicode/candidates.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    summary = [
        "## SAHROUD DIGI CODE — گزارش نوبت پایش",
        f"- زمان آخرین بررسی (UTC): {checked_at}",
        f"- وضعیت منابع: {output['monitor_status']}",
        f"- تعداد سرنخ‌ها: {len(candidates)}",
        f"- تغییر در گزارش کدها: {'بله' if data_changed else 'خیر'}",
        f"- خطای منابع: {len(errors)}",
        "- اعتبار کدها و درصد تخفیف باید در حساب/صفحه رسمی دیجی‌کالا آزمایش شود؛ این گزارش تأیید پذیرش نیست.",
    ]
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as f:
            f.write("\\n".join(summary) + "\\n")
    print(json.dumps({"checked_at": checked_at, "codes_found": len(candidates), "source_errors": len(errors), "data_changed": data_changed}, ensure_ascii=False))

if __name__ == "__main__":
    main()
