#!/usr/bin/env python3
"""Public-source Digikala discount-code monitor with bounded image OCR.
Only fetches publicly accessible pages/images; never logs in or bypasses controls."""
import hashlib, html, json, os, re, subprocess, tempfile, time
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

UA = "Mozilla/5.0 (compatible; SAHROUD-DIGI-CODE/2.0; +https://github.com/sahroud/danky)"
JACKED_URL = "https://www.digikala.com/landings/prize-catcher/"
TELEGRAM = "https://t.me/s/digikalaofficialaccount"
CODE_RE = re.compile(r"\b[A-Z0-9][A-Z0-9_-]{4,15}\b", re.I)
HINT_RE = re.compile(r"جاکدی|جاکُدی|کد\s*تخفیف|کد\s*را\s*وارد|ارسال\s*رایگان|کد\s*ارسال|discount\s*code|coupon|promo\s*code", re.I)
MAX_PAGES, MAX_IMAGES, MAX_BYTES = 24, 120, 3_000_000

def now():
    return datetime.now(timezone.utc).isoformat()

def code_context(text, match):
    before=text[max(0,match.start()-55):match.start()]
    after=text[match.end():min(len(text),match.end()+70)]
    # Jacked-code shape: DK followed by exactly 3 or 4 letters/digits.
    # Campaign wording may be on a separate line, so inspect a wider context.
    around=text[max(0,match.start()-420):min(len(text),match.end()+420)]
    is_jacked_shape=bool(re.fullmatch(r"DK[A-Z0-9]{3,4}",match.group(0).upper()))
    jacked_signal=bool(re.search(r"جاکدی|جاکُدی|prize.?catcher|کدهای?\s+۵\s*یا\s*۶|کدهای?\s+5\s*یا\s*6",around,re.I))
    if is_jacked_shape and jacked_signal:
        return around
    before_signal=re.search(r"(?:کد(?:\s*(?:تخفیف|ارسال|یادت\s*نره))?|جاکدی|جاکُدی|coupon(?:\s*code)?|promo\s*code|discount\s*code)\s*[:：]?\s*$",before,re.I)
    after_signal=re.match(r"\s*(?:رو\s*توی\s*جاکدی|در\s*جاکدی|ارسال\s*رایگان|برای\s*خرید|کد\s*تخفیف)",after,re.I)
    if not (before_signal or after_signal):
        return None
    return text[max(0,match.start()-180):min(len(text),match.end()+180)]

def get(url, limit=2_000_000):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=18) as r:
        return r.read(limit), r.headers.get("Content-Type", "")

class Links(HTMLParser):
    def __init__(self):
        super().__init__(); self.hrefs=[]; self.images=[]
    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        if tag == "a" and a.get("href"): self.hrefs.append(a["href"])
        if tag in ("img","source"):
            for k in ("src","data-src","data-original","data-lazy","data-srcset","srcset"):
                v=a.get(k)
                if v:
                    self.images.extend(x.strip().split(" ")[0] for x in v.split(",") if x.strip())
        if tag == "meta" and a.get("content") and a.get("property","").lower() in ("og:image","og:image:url"):
            self.images.append(a["content"])

def allowed_page(url):
    p=urlparse(url)
    return p.scheme=="https" and p.netloc in ("www.digikala.com","digikala.com") and ("prize-catcher" in p.path or "category" in p.path.lower() or "/product/" in p.path.lower())

def allowed_image(url):
    p=urlparse(url)
    return p.scheme=="https" and (p.netloc.endswith("digikala.com") or p.netloc.endswith("digikala.net") or p.netloc.endswith("torob.com") or p.netloc.endswith("t.me"))

def main():
    checked=now()
    try:
        with open("digicode/candidates.json",encoding="utf-8") as f: previous=json.load(f)
    except Exception: previous={}
    old={x.get("code"):x for x in previous.get("candidates",[]) if x.get("code")}
    pages=[("https://www.digikala.com/","وب‌سایت عمومی دیجی‌کالا"),(TELEGRAM,"کانال رسمی دیجی‌کالا")]
    visited=set(); images=[]; found={}; errors=[]
    for url,label in pages[:2]:
        visited.add(url)
        try:
            raw,_=get(url); body=raw.decode("utf-8","replace")
            parser=Links(); parser.feed(body)
            for src in parser.images:
                u=urljoin(url,src)
                if allowed_image(u): images.append((u,label,url))
            for href in parser.hrefs:
                u=urljoin(url,href).split("#")[0]
                if allowed_page(u) and u not in {p[0] for p in pages} and len(pages)<MAX_PAGES:
                    pages.append((u,"صفحه عمومی محصول" if "/product/" in urlparse(u).path else "صفحه عمومی دسته‌بندی/کمپین"))
            text=html.unescape(re.sub(r"<[^>]+>"," ",body))
            for match in CODE_RE.finditer(text):
                code=match.group(0).upper()
                context=code_context(text,match)
                if context:
                    if re.fullmatch(r"DK[A-Z0-9]{3,4}",code) and re.search(r"جاکدی|جاکُدی",context,re.I):
                        code_type="کد جاکدی"
                    elif re.search(r"ارسال\s*رایگان",context):
                        code_type="کد ارسال رایگان"
                    elif re.search(r"دیجی\s*پی|پرداخت\s*اعتباری",context):
                        code_type="کد پرداخت اعتباری"
                    else:
                        code_type="کد تخفیف خرید"
                    found[code]={"code":code,"code_type":code_type,"source_name":label,"source_url":url,"source_type":"official" if "دیجی‌کالا" in label else "public","discount_percent":None,"status":"کد احتمالی؛ پذیرش هنوز آزمایش نشده","excerpt":context[:400]}
        except Exception as e: errors.append({"source":label,"error":str(e)[:180]})
    # Crawl a small, bounded number of public category pages and collect product images.
    idx=2
    while idx < min(len(pages),MAX_PAGES):
        url,label=pages[idx]; idx+=1
        if url in visited: continue
        visited.add(url)
        try:
            raw,_=get(url); parser=Links(); parser.feed(raw.decode("utf-8","replace"))
            for src in parser.images:
                u=urljoin(url,src)
                if allowed_image(u): images.append((u,label,url))
            text=html.unescape(re.sub(r"<[^>]+>"," ",raw.decode("utf-8","replace")))
            for match in CODE_RE.finditer(text):
                code=match.group(0).upper()
                context=code_context(text,match)
                if context:
                    if re.fullmatch(r"DK[A-Z0-9]{3,4}",code) and re.search(r"جاکدی|جاکُدی",context,re.I): code_type="کد جاکدی"
                    elif re.search(r"ارسال\s*رایگان",context): code_type="کد ارسال رایگان"
                    elif re.search(r"دیجی\s*پی|پرداخت\s*اعتباری",context): code_type="کد پرداخت اعتباری"
                    else: code_type="کد تخفیف خرید"
                    found.setdefault(code,{"code":code,"code_type":code_type,"source_name":label,"source_url":url,"source_type":"public","discount_percent":None,"status":"کد احتمالی؛ نیازمند تأیید","excerpt":context[:400]})
        except Exception as e: errors.append({"source":url[:100],"error":str(e)[:160]})
    # OCR only publicly linked images, with strict limits and a small request delay.
    seen=set(); downloaded=0; ocr_count=0; image_hashes=set()
    for img_url,label,page_url in images:
        if len(seen)>=MAX_IMAGES: break
        if img_url in seen: continue
        seen.add(img_url)
        try:
            data,ctype=get(img_url,MAX_BYTES)
            if len(data)<1500 or len(data)>=MAX_BYTES or (ctype and not ctype.startswith("image/")): continue
            digest=hashlib.sha256(data).hexdigest()
            if digest in image_hashes: continue
            image_hashes.add(digest); downloaded+=1
            suffix=".jpg"
            if "png" in ctype: suffix=".png"
            elif "webp" in ctype: suffix=".webp"
            with tempfile.NamedTemporaryFile(suffix=suffix) as tmp:
                tmp.write(data); tmp.flush()
                result=subprocess.run(["tesseract",tmp.name,"stdout","-l","eng"],capture_output=True,text=True,timeout=12)
            ocr=result.stdout or ""
            if result.returncode==0: ocr_count+=1
            for match in CODE_RE.finditer(ocr):
                code=match.group(0).upper()
                context=code_context(ocr,match)
                if context:
                    if re.fullmatch(r"DK[A-Z0-9]{3,4}",code) and re.search(r"جاکدی|جاکُدی",context,re.I): code_type="کد جاکدی"
                    elif re.search(r"ارسال\s*رایگان",context): code_type="کد ارسال رایگان"
                    elif re.search(r"دیجی\s*پی|پرداخت\s*اعتباری",context): code_type="کد پرداخت اعتباری"
                    else: code_type="کد تخفیف خرید"
                    found.setdefault(code,{"code":code,"code_type":code_type,"source_name":"OCR تصویر عمومی دیجی‌کالا","source_url":page_url,"image_url":img_url,"source_type":"image_ocr","discount_percent":None,"status":"کد احتمالی استخراج‌شده از تصویر؛ نیازمند آزمایش","excerpt":context[:300]})
            time.sleep(.12)
        except Exception:
            continue
    candidates=[]
    for code,item in found.items():
        prior=old.get(code,{})
        item["seen_at"]=prior.get("seen_at") or checked
        item["last_seen_at"]=checked
        candidates.append(item)
    # Retain older leads if sources temporarily fail; never promote them to verified.
    if not candidates and errors:
        candidates=[{**v,"status":"سرنخ قبلی؛ منبع این نوبت در دسترس نبود"} for v in old.values()]
    candidates.sort(key=lambda x:(x.get("discount_percent") or 0),reverse=True)
    output={"updated_at":now(),"last_checked_at":checked,"monitor_status":"ok" if not errors else ("partial" if candidates else "unavailable"),"scan_stats":{"pages_checked":len(visited),"public_images_seen":len(seen),"images_downloaded":downloaded,"images_ocr_processed":ocr_count,"unique_image_hashes":len(image_hashes),"ocr_enabled":True},"notice":"تمام موارد صرفاً سرنخ عمومی یا OCR هستند؛ اعتبار هر کد باید در حساب/جاکدی دیجی‌کالا آزمایش شود.","candidates":candidates,"source_errors":errors}
    os.makedirs("digicode",exist_ok=True)
    with open("digicode/candidates.json","w",encoding="utf-8") as f: json.dump(output,f,ensure_ascii=False,indent=2)
    summary=os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary,"a",encoding="utf-8") as f:
            f.write(f"\n- بررسی: {checked}\n- صفحات: {output['scan_stats']['pages_checked']}\n- تصاویر OCR شده: {len(seen)}\n- سرنخ‌ها: {len(candidates)}\n- خطاها: {len(errors)}\n")
    print(json.dumps({"checked_at":checked,"leads":len(candidates),"pages":output["scan_stats"]["pages_checked"],"images_seen":len(seen),"images_downloaded":downloaded,"images_ocr":ocr_count,"errors":len(errors)},ensure_ascii=False))

if __name__=="__main__": main()
