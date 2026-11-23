#!/usr/bin/env python3
"""Read public Digikala campaign announcements and publish code candidates.
Candidates are leads only: the app never claims a code is accepted until the user tests it.
"""
import html
import json
import re
import urllib.request
from datetime import datetime, timezone

SOURCES = [
    ("Digikala official Telegram", "https://t.me/s/digikalaofficialaccount"),
    ("Digikala treasure hunt", "https://www.digikala.com/landings/prize-catcher/"),
]
CODE_RE = re.compile(r"\bDK[A-Z0-9]{3,4}\b", re.I)
HINT_RE = re.compile(r"جاکدی|جاکُدی|کد تخفیف|شکار گنج|prize.?catcher", re.I)
PERCENT_RE = re.compile(r"(\d{1,3})\s*٪|%\s*(\d{1,3})")

def get_page(url):
    req = urllib.request.Request(url, headers={"User-Agent": "SAHROUD-DIGI-CODE/1.0 (public campaign monitor)"})
    with urllib.request.urlopen(req, timeout=20) as response:
        return response.read(3_000_000).decode("utf-8", "replace")

def plain(text):
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", html.unescape(text))

def main():
    found = {}
    errors = []
    for label, url in SOURCES:
        try:
            raw = get_page(url)
            # Inspect bounded text windows around each code so unrelated page text is not attributed.
            for match in CODE_RE.finditer(raw.upper()):
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
                    "seen_at": datetime.now(timezone.utc).isoformat(),
                    "excerpt": snippet[:420],
                }
        except Exception as exc:
            errors.append({"source": label, "error": str(exc)[:240]})
    output = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "monitor_status": "ok" if found or not errors else "partial",
        "notice": "کاندیداها سرنخ هستند؛ اعتبار و مقدار تخفیف فقط با آزمایش در جاکدی/صفحه رسمی مشخص می‌شود.",
        "candidates": sorted(found.values(), key=lambda x: (x["discount_percent"] or 0), reverse=True),
        "source_errors": errors,
    }
    with open("digicode/candidates.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(json.dumps({"codes_found": len(found), "source_errors": len(errors)}, ensure_ascii=False))

if __name__ == "__main__":
    main()
