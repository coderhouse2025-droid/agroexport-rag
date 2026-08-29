"""
Re-extrae y persiste el texto completo de los PDFs ya descargados por
downloader.py, sin volver a bajar nada de internet.

Por qué existe este script: downloader.py extrae el texto de cada PDF para
detectar cultivos mencionados, pero solo guarda el LARGO del texto
(`texto_extraido_chars`) en senasa_index_con_texto.json -- nunca el texto en
sí. Para el paso de chunking necesitamos el texto completo, así que este
script vuelve a abrir cada PDF local (los que ya bajaste a tu Drive/disco) y
esta vez sí lo persiste, en `data/processed/textos/<archivo>.txt`.

Uso:
    python extract_text_local.py --pdf-dir /ruta/a/tus/pdfs --index ../senasa_index_con_texto.json
"""

import argparse
import json
from pathlib import Path

from pypdf import PdfReader

try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    SCRIPT_DIR = Path.cwd()


def extract_text(pdf_path: Path) -> str:
    try:
        reader = PdfReader(str(pdf_path))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    except Exception as e:
        print(f"  [error extraccion] {pdf_path.name}: {e}")
        return ""


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--index", default="../data/raw/senasa_index_con_texto.json", help="Índice con 'archivo_local' por documento")
    parser.add_argument("--pdf-dir", default="../data/raw/pdfs", help="Carpeta donde están los PDFs ya descargados (ej. la que bajaste de Drive)")
    parser.add_argument("--out-dir", default="../data/processed/textos", help="Carpeta donde se guarda un .txt por documento")
    parser.add_argument("--out-index", default="../data/processed/senasa_index_con_texto_completo.json", help="Copia del índice + ruta al .txt de cada documento")
    args, _unknown = parser.parse_known_args()

    index_path = SCRIPT_DIR / args.index
    pdf_dir = SCRIPT_DIR / args.pdf_dir
    out_dir = SCRIPT_DIR / args.out_dir
    out_index_path = SCRIPT_DIR / args.out_index
    out_dir.mkdir(parents=True, exist_ok=True)
    out_index_path.parent.mkdir(parents=True, exist_ok=True)

    items = json.loads(index_path.read_text(encoding="utf-8"))
    print(f"{len(items)} documentos en el índice")

    encontrados = 0
    faltantes = 0
    resultados = []
    for i, item in enumerate(items):
        archivo_local = item.get("archivo_local")
        if not archivo_local:
            resultados.append(item)
            continue

        # archivo_local viene como "pdfs/0009.pdf" (relativo a la carpeta del
        # scraper original) -- acá lo resolvemos contra --pdf-dir en vez de
        # asumir la misma estructura de carpetas que tenía el scraper.
        pdf_path = pdf_dir / Path(archivo_local).name
        if not pdf_path.exists():
            faltantes += 1
            resultados.append(item)
            continue

        texto = extract_text(pdf_path)
        if texto.strip():
            txt_filename = f"{Path(archivo_local).stem}.txt"
            (out_dir / txt_filename).write_text(texto, encoding="utf-8")
            item = {**item, "texto_local": f"textos/{txt_filename}", "texto_extraido_chars": len(texto)}
            encontrados += 1
        resultados.append(item)

        if (i + 1) % 25 == 0:
            print(f"  procesados {i + 1}/{len(items)}...")

    out_index_path.write_text(json.dumps(resultados, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nPDFs encontrados y con texto extraído: {encontrados}")
    print(f"PDFs no encontrados en --pdf-dir (revisar ruta): {faltantes}")
    print(f"Textos guardados en: {out_dir.resolve()}")
    print(f"Índice actualizado guardado en: {out_index_path.resolve()}")
    print("\nSiguiente paso: chunking.py, que ahora sí va a poder leer el texto completo de estos documentos.")


if __name__ == "__main__":
    main()
