#!/usr/bin/env python3
"""Public-source Digikala treasure-hunt monitor with bounded image OCR.
Only fetches publicly accessible pages/images; never logs in or bypasses controls."""
import hashlib, html, json, os, re, subprocess, tempfile, time
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

UA = "Mozilla/5.0 (compatible; SAHROUD-DIGI-CODE/2.0; +https://github.com/sahroud/danky)"
HUNT = "https://www.digikala.com/landings/prize-catcher/"
TELEGRAM = "https://t.me/s/digikalaofficialaccount"
CODE_RE = re.compile(r"\bDK[A-Z0-9]{3,8}\b", re.I)
HINT_RE = re.compile(r"شکار\s*گنج|جاکدی|جاکُدی|prize.?catcher|کد\s*تخفیف", re.I)
MAX_PAGES, MAX_IMAGES, MAX_BYTES = 24, 120, 3_000_000

def now():
    return datetime.now(timezone.utc).isoformat()

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
    pages=[(HUNT,"صفحه رسمی شکار گنج"),(TELEGRAM,"کانال عمومی دیجی‌کالا")]
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
            if HINT_RE.search(text):
                for code in CODE_RE.findall(text):
                    found[code.upper()]={"code":code.upper(),"source_name":label,"source_url":url,"source_type":"official" if "دیجی‌کالا" in label else "public","discount_percent":None,"status":"سرنخ متنی؛ پذیرش هنوز آزمایش نشده","excerpt":text[max(0,text.upper().find(code.upper())-180):text.upper().find(code.upper())+220][:400]}
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
            for code in CODE_RE.findall(text):
                if HINT_RE.search(text[max(0,text.upper().find(code.upper())-160):text.upper().find(code.upper())+200]):
                    found.setdefault(code.upper(),{"code":code.upper(),"source_name":label,"source_url":url,"source_type":"public","discount_percent":None,"status":"سرنخ متنی؛ نیازمند تأیید","excerpt":"کد در متن صفحه عمومی دیده شد."})
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
            for code in CODE_RE.findall(ocr):
                code=code.upper()
                found.setdefault(code,{"code":code,"source_name":"OCR تصویر عمومی محصول/کمپین","source_url":page_url,"image_url":img_url,"source_type":"image_ocr","discount_percent":None,"status":"سرنخ استخراج‌شده از تصویر؛ حتماً در صفحه رسمی بررسی شود","excerpt":ocr[:300]})
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
    output={"updated_at":now(),"last_checked_at":checked,"monitor_status":"ok" if not errors else ("partial" if candidates else "unavailable"),"scan_stats":{"pages_checked":len(visited)+2,"public_images_seen":len(seen),"images_downloaded":downloaded,"images_ocr_processed":ocr_count,"unique_image_hashes":len(image_hashes),"ocr_enabled":True},"notice":"تمام موارد صرفاً سرنخ عمومی یا OCR هستند؛ هیچ‌کدام بدون آزمایش در صفحه رسمی تأییدشده نیستند.","candidates":candidates,"source_errors":errors}
    os.makedirs("digicode",exist_ok=True)
    with open("digicode/candidates.json","w",encoding="utf-8") as f: json.dump(output,f,ensure_ascii=False,indent=2)
    summary=os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary,"a",encoding="utf-8") as f:
            f.write(f"\n- بررسی: {checked}\n- صفحات: {output['scan_stats']['pages_checked']}\n- تصاویر OCR شده: {len(seen)}\n- سرنخ‌ها: {len(candidates)}\n- خطاها: {len(errors)}\n")
    print(json.dumps({"checked_at":checked,"leads":len(candidates),"pages":output["scan_stats"]["pages_checked"],"images_seen":len(seen),"images_downloaded":downloaded,"images_ocr":ocr_count,"errors":len(errors)},ensure_ascii=False))

if __name__=="__main__": main()
