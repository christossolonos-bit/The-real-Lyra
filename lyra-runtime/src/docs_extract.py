# Text out of a document Chris sends Lyra (lyra-runtime/src/attachments.js runs this with python -P -E).
# usage: python -P -E docs_extract.py <file>   ->   the text on stdout (UTF-8)
# PDF via pypdf; Word / PowerPoint / Excel by reading the XML inside the file (no extra packages).
# python -P -E docs_extract.py --render <file.pdf> <folder> <max pages>   ->   page images p1.jpg, p2.jpg... (pypdfium2),
# so she can look at a page (charts, photos, scanned pages); prints the page count
import re, sys, zipfile, html

def xml_text(xml):
    xml = re.sub(r"</w:p>|</a:p>|<w:br/>|<w:tab/>", "\n", xml)
    return html.unescape(re.sub(r"<[^>]+>", "", xml))

def main(path):
    low = path.lower()
    if low.endswith(".pdf"):
        from pypdf import PdfReader
        r = PdfReader(path)
        return "\n\n".join(f"[page {i + 1}]\n{(p.extract_text() or '').strip()}" for i, p in enumerate(r.pages))
    if low.endswith(".docx"):
        with zipfile.ZipFile(path) as z:
            return xml_text(z.read("word/document.xml").decode("utf8", "ignore"))
    if low.endswith(".pptx"):
        with zipfile.ZipFile(path) as z:
            slides = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=lambda n: int(re.findall(r"\d+", n)[-1]))
            return "\n\n".join(f"[slide {i + 1}]\n{xml_text(z.read(n).decode('utf8', 'ignore')).strip()}" for i, n in enumerate(slides))
    if low.endswith(".xlsx"):
        with zipfile.ZipFile(path) as z:
            shared = []
            if "xl/sharedStrings.xml" in z.namelist():
                shared = [html.unescape(re.sub(r"<[^>]+>", "", s)) for s in re.findall(r"<si>(.*?)</si>", z.read("xl/sharedStrings.xml").decode("utf8", "ignore"), re.S)]
            out = []
            for n in sorted(x for x in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", x)):
                out.append(f"[{n.split('/')[-1].replace('.xml', '')}]")
                for row in re.findall(r"<row[^>]*>(.*?)</row>", z.read(n).decode("utf8", "ignore"), re.S):
                    cells = []
                    for attrs, val in re.findall(r"<c([^>]*)>(?:.*?<v>(.*?)</v>)?.*?</c>", row, re.S):
                        cells.append(shared[int(val)] if 't="s"' in attrs and val.isdigit() and int(val) < len(shared) else val)
                    if any(cells):
                        out.append("\t".join(cells))
            return "\n".join(out)
    with open(path, "rb") as f:
        return f.read().decode("utf8", "ignore")

def render(path, folder, most):
    import os
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(path)
    os.makedirs(folder, exist_ok=True)
    for i in range(min(len(pdf), most)):
        page = pdf[i]
        w = page.get_width()
        img = page.render(scale=max(1.0, min(2.5, 1400 / max(w, 1)))).to_pil().convert("RGB")
        img.save(os.path.join(folder, f"p{i + 1}.jpg"), quality=82)
    return len(pdf)

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if sys.argv[1] == "--render":
        print(render(sys.argv[2], sys.argv[3], int(sys.argv[4])))
    else:
        print(main(sys.argv[1]))
