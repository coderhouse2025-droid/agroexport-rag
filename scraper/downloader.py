"""
Downloader de PDFs a partir del índice generado por senasa_repositorio.py,
con extracción de texto y filtro por mención explícita de cultivo.

Por qué el filtro de cultivo va acá y no en el scraping: como se vio con la
keyword 'fitosanitario' (114 de 234 documentos), muchos títulos no alcanzan
para juzgar relevancia -- normativa fitosanitaria general (control de
plagas, buenas practicas agricolas) puede o no mencionar soja/maiz/trigo/
girasol en el cuerpo del texto. El filtro confiable es sobre el texto
extraido, no sobre el titulo ni la keyword de busqueda que lo trajo.

Requiere: pip install pypdf --break-system-packages

Uso:
    python downloader.py --index ../data/raw/senasa_repositorio_index.json
"""

import argparse
import json
import re
import time
from pathlib import Path
from urllib.request import urlopen, Request

from pypdf import PdfReader

RATE_LIMIT_SECONDS = 0.5

CROP_PATTERNS = {
    "soja": [r"\bsoja\b", r"\bsoya\b"],
    "maiz": [r"\bma[ií]z\b"],
    "trigo": [r"\btrigo\b"],
    "girasol": [r"\bgirasol\b"],
    "oleaginosas": [r"\boleaginosa"],
    "granos": [r"\bgranos?\b", r"\bcereales?\b"],
}


def download_pdf(url: str, dest: Path) -> bool:
    try:
        req = Request(url, headers={"User-Agent": "agroexport-rag/0.1 (uso institucional)"})
        with urlopen(req, timeout=30) as resp:
            dest.write_bytes(resp.read())
        return True
    except Exception as e:
        print(f"  [error descarga] {e}")
        return False


def extract_text(pdf_path: Path) -> str:
    try:
        reader = PdfReader(str(pdf_path))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    except Exception as e:
        print(f"  [error extraccion] {e}")
        return ""


def matched_crops(text: str) -> list[str]:
    text_lower = text.lower()
    return [crop for crop, patterns in CROP_PATTERNS.items() if any(re.search(p, text_lower) for p in patterns)]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--index", default="../data/raw/senasa_repositorio_index.json")
    parser.add_argument("--pdf-dir", default="../data/raw/pdfs")
    parser.add_argument("--out", default="../data/processed/senasa_index_con_texto.json")
    args = parser.parse_args()

    index_path = Path(__file__).parent / args.index
    pdf_dir = Path(__file__).parent / args.pdf_dir
    out_path = Path(__file__).parent / args.out
    pdf_dir.mkdir(parents=True, exist_ok=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    items = json.loads(index_path.read_text(encoding="utf-8"))
    print(f"{len(items)} documentos en el índice")

    results = []
    for i, item in enumerate(items):
        pdf_url = item.get("pdf_url")
        if not pdf_url:
            continue
        dest = pdf_dir / f"{i:04d}.pdf"
        print(f"[{i+1}/{len(items)}] {item.get('titulo')}")
        if not download_pdf(pdf_url, dest):
            continue
        time.sleep(RATE_LIMIT_SECONDS)

        text = extract_text(dest)
        crops = matched_crops(text)

        results.append(
            {
                **item,
                "archivo_local": str(dest.relative_to(Path(__file__).parent)),
                "cultivos_mencionados": crops,
                "texto_extraido_chars": len(text),
            }
        )

    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    relevantes = [r for r in results if r["cultivos_mencionados"]]
    print(f"\nProcesados: {len(results)}")
    print(f"Con mención explícita de cultivo: {len(relevantes)}")
    print(f"Sin mención (candidatos a descarte): {len(results) - len(relevantes)}")
    print(f"Índice enriquecido guardado en: {out_path.resolve()}")


if __name__ == "__main__":
    main()
