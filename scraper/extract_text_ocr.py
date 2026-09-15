"""
Segunda pasada de extracción de texto, con OCR, para los PDFs del
Repositorio SENASA que quedaron sin texto después de extract_text_local.py
(son escaneos -- imágenes de página, sin capa de texto real, así que pypdf
devuelve texto vacío por más que el archivo exista y se pueda abrir).

Solo toca los documentos que YA están marcados sin 'texto_local' en el
índice -- no vuelve a tocar los 154 que ya están bien, para no gastar
tiempo de más.

Requiere:
  - El motor Tesseract OCR instalado en el sistema (no es un paquete de
    Python, es un programa aparte): https://github.com/UB-Mannheim/tesseract/wiki
    En Windows, si no quedó en el PATH, pasar su ubicación con --tesseract-cmd
    (típicamente "C:\\Program Files\\Tesseract-OCR\\tesseract.exe").
  - pip install pytesseract PyMuPDF

Uso:
    python extract_text_ocr.py --index ../data/processed/senasa_index_con_texto_completo.json
    python extract_text_ocr.py --tesseract-cmd "C:\\Program Files\\Tesseract-OCR\\tesseract.exe"  # si hace falta
"""

import argparse
import json
from pathlib import Path

import pymupdf
import pytesseract
from PIL import Image

try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    SCRIPT_DIR = Path.cwd()

# a más DPI, mejor reconocimiento pero más lento -- 200 es un buen punto
# medio para texto de tamaño normal en un documento oficial
DPI_RENDER = 200


def ocr_pdf(pdf_path: Path) -> str:
    """Renderiza cada página a imagen y le corre OCR en español. Sigue con
    la página siguiente si una página puntual falla, en vez de perder todo
    el documento por un solo error."""
    textos_paginas = []
    try:
        doc = pymupdf.open(str(pdf_path))
    except Exception as e:
        print(f"  [error abriendo PDF] {pdf_path.name}: {e}")
        return ""

    zoom = DPI_RENDER / 72  # pymupdf renderiza a 72 dpi por default
    matriz = pymupdf.Matrix(zoom, zoom)
    for num_pagina in range(len(doc)):
        try:
            pagina = doc[num_pagina]
            pix = pagina.get_pixmap(matrix=matriz)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            texto_pagina = pytesseract.image_to_string(img, lang="spa")
            textos_paginas.append(texto_pagina)
        except Exception as e:
            print(f"  [error OCR pág. {num_pagina + 1}] {pdf_path.name}: {e}")
    doc.close()
    return "\n".join(textos_paginas)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--index", default="../data/processed/senasa_index_con_texto_completo.json")
    parser.add_argument("--pdf-dir", default="../data/raw/pdfs")
    parser.add_argument("--out-dir", default="../data/processed/textos")
    parser.add_argument("--out-index", default="../data/processed/senasa_index_con_texto_completo.json")
    parser.add_argument("--tesseract-cmd", default=None, help=r'Ruta al ejecutable de Tesseract si no está en el PATH, ej. "C:\Program Files\Tesseract-OCR\tesseract.exe"')
    args, _unknown = parser.parse_known_args()

    if args.tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = args.tesseract_cmd

    index_path = SCRIPT_DIR / args.index
    pdf_dir = SCRIPT_DIR / args.pdf_dir
    out_dir = SCRIPT_DIR / args.out_dir
    out_index_path = SCRIPT_DIR / args.out_index
    out_dir.mkdir(parents=True, exist_ok=True)

    items = json.loads(index_path.read_text(encoding="utf-8"))
    pendientes = [item for item in items if not item.get("texto_local")]
    print(f"{len(items)} documentos en el índice, {len(pendientes)} sin texto (candidatos a OCR)")

    logrados = 0
    fallidos = 0
    for i, item in enumerate(pendientes):
        archivo_local = item.get("archivo_local")
        if not archivo_local:
            continue
        pdf_path = pdf_dir / Path(archivo_local).name
        if not pdf_path.exists():
            print(f"  [no encontrado] {pdf_path.name}")
            fallidos += 1
            continue

        print(f"[{i + 1}/{len(pendientes)}] OCR: {item.get('titulo', pdf_path.name)}")
        texto = ocr_pdf(pdf_path)
        if texto.strip():
            txt_filename = f"{Path(archivo_local).stem}.txt"
            (out_dir / txt_filename).write_text(texto, encoding="utf-8")
            item["texto_local"] = f"textos/{txt_filename}"
            item["texto_extraido_chars"] = len(texto)
            item["texto_via_ocr"] = True  # para distinguir de la extracción directa, por si hace falta revisar calidad después
            logrados += 1
        else:
            fallidos += 1

    # actualiza los items en el índice original (mismo objeto por referencia
    # ya que 'pendientes' son los mismos dicts que están en 'items')
    out_index_path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nOCR exitoso: {logrados}")
    print(f"Sin texto ni con OCR (revisar manualmente): {fallidos}")
    print(f"Índice actualizado guardado en: {out_index_path.resolve()}")
    print("\nSiguiente paso: chunking.py, que ahora va a poder leer también estos documentos.")


if __name__ == "__main__":
    main()
