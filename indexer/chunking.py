"""
Chunking unificado: junta el Repositorio Institucional SENASA y las noticias
de argentina.gob.ar en un solo esquema de metadata, listo para indexar.

Esquema común por chunk:
    chunk_id, fuente ("repositorio" | "noticia"), documento_id, titulo,
    organismo_emisor, tipo_norma, numero_norma, anio, fecha, fecha_iso,
    pais_destino, cultivos, url, chunk_index, total_chunks, texto

Notas de diseño:
  - Repositorio SENASA: los títulos siguen el patrón
    "<Tipo> <Organismo> N° <numero>/<año>" (ej. "Resolución SAGPyA N° 0538/2003").
    De ahí se parsean tipo_norma, organismo_emisor, numero_norma y anio sin
    necesidad de abrir el PDF. cultivos sale de 'cultivos_mencionados'
    (ya filtrado por downloader.py). pais_destino queda None: la normativa
    del Repositorio es en general nacional, no bilateral por país.
  - Noticias: cultivos y pais_destino se declaran a mano por URL en
    PRODUCTOS_POR_URL / PAIS_POR_URL (son solo 3 noticias, no vale la pena
    inferirlo automáticamente todavía; si la lista crece hay que revisar esto).
  - vigente queda como None ("desconocido") en las dos fuentes -- determinar
    vigencia real es un paso aparte (parte del roadmap del README, sección 5).
  - Si un documento del Repositorio no tiene texto completo persistido
    (ver extract_text_local.py), se listra como documento pendiente y no se
    generan chunks para él, en vez de fallar.

Uso:
    python chunking.py \
        --repositorio ../data/processed/senasa_index_con_texto_completo.json \
        --noticias ../data/raw/argentina_noticias_index.json \
        --textos-dir ../data/processed/textos \
        --out ../data/processed/chunks.json
"""

import argparse
import json
import re
from pathlib import Path

try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    SCRIPT_DIR = Path.cwd()

CHUNK_MAX_CHARS = 1000
CHUNK_MIN_CHARS = 200  # no vale la pena un chunk final muy corto suelto; se lo pega al anterior

# Patrón típico de los títulos del Repositorio, ej:
#   "Resolución SAGPyA N° 0538/2003"
#   "Disposición DNPV N° 0009/2003"
#   "Resolución ex-SENASA N° 1039/1992"
TITULO_PATTERN = re.compile(
    r"^(?P<tipo>Resoluci[oó]n|Disposici[oó]n)\s+(?P<organismo>[\w\-\.\s]+?)\s+N[°º]\s*(?P<numero>[\d/]+)",
    re.IGNORECASE,
)

# Metadata manual para noticias (son pocas -- si esta lista crece conviene
# automatizarlo a partir del cuerpo/título en vez de mantenerlo a mano)
PAIS_POR_URL = {
    "inscripcion-para-exportadores-de-granos-de-cebada-trigo-soja-sorgo-y-maiz-china-3": "China",
    "protocolo-de-requisitos-fitosanitarios-para-la-exportacion-de-granos-china": "China",
    "argentina-comienza-usar-certificacion-fitosanitaria-electronica-para-exportar-brasil": "Brasil",
}
PRODUCTOS_POR_URL = {
    "inscripcion-para-exportadores-de-granos-de-cebada-trigo-soja-sorgo-y-maiz-china-3": ["cebada", "trigo", "soja", "sorgo", "maiz"],
    "protocolo-de-requisitos-fitosanitarios-para-la-exportacion-de-granos-china": ["trigo", "sorgo", "maiz", "cebada", "soja"],
    "argentina-comienza-usar-certificacion-fitosanitaria-electronica-para-exportar-brasil": ["trigo", "cebada"],
}


def parse_titulo(titulo: str) -> dict:
    """Extrae tipo de norma, organismo, número y año del título, si matchea el patrón conocido."""
    m = TITULO_PATTERN.match(titulo.strip())
    if not m:
        return {"tipo_norma": None, "organismo_emisor": None, "numero_norma": None, "anio": None}
    numero_completo = m.group("numero")
    anio = None
    if "/" in numero_completo:
        anio_str = numero_completo.split("/")[-1]
        if anio_str.isdigit():
            anio = int(anio_str) if len(anio_str) == 4 else (1900 + int(anio_str) if int(anio_str) > 50 else 2000 + int(anio_str))
    return {
        "tipo_norma": m.group("tipo").capitalize(),
        "organismo_emisor": m.group("organismo"),
        "numero_norma": numero_completo,
        "anio": anio,
    }


def chunk_text(texto: str, max_chars: int = CHUNK_MAX_CHARS, min_chars: int = CHUNK_MIN_CHARS) -> list[str]:
    """Chunking simple por párrafo: agrupa párrafos consecutivos hasta acercarse
    a max_chars. Si un párrafo individual ya supera max_chars, se corta por
    oración. Evita chunks finales demasiado cortos, pegándolos al anterior."""
    parrafos = [p.strip() for p in texto.split("\n") if p.strip()]
    chunks = []
    actual = ""
    for p in parrafos:
        candidato = f"{actual}\n{p}".strip() if actual else p
        if len(candidato) <= max_chars:
            actual = candidato
            continue
        if actual:
            chunks.append(actual)
        if len(p) <= max_chars:
            actual = p
        else:
            # párrafo demasiado largo: cortar por oración
            oraciones = re.split(r"(?<=[.;])\s+", p)
            sub = ""
            for o in oraciones:
                cand = f"{sub} {o}".strip() if sub else o
                if len(cand) <= max_chars:
                    sub = cand
                else:
                    if sub:
                        chunks.append(sub)
                    sub = o
            actual = sub
    if actual:
        chunks.append(actual)

    # fusionar el último chunk si quedó muy corto
    if len(chunks) >= 2 and len(chunks[-1]) < min_chars:
        chunks[-2] = f"{chunks[-2]}\n{chunks[-1]}"
        chunks.pop()
    return chunks


def build_chunks_repositorio(items: list[dict], textos_dir: Path) -> tuple[list[dict], int]:
    chunks = []
    pendientes = 0
    for item in items:
        texto_local = item.get("texto_local")
        if not texto_local:
            pendientes += 1
            continue
        texto_path = textos_dir / Path(texto_local).name
        if not texto_path.exists():
            pendientes += 1
            continue
        texto = texto_path.read_text(encoding="utf-8")
        if not texto.strip():
            pendientes += 1
            continue

        meta_titulo = parse_titulo(item.get("titulo", ""))
        documento_id = item.get("item_url", item.get("titulo"))
        partes = chunk_text(texto)
        for idx, parte in enumerate(partes):
            chunks.append(
                {
                    "chunk_id": f"repositorio:{documento_id}:{idx}",
                    "fuente": "repositorio",
                    "documento_id": documento_id,
                    "titulo": item.get("titulo"),
                    **meta_titulo,
                    "fecha": None,
                    "fecha_iso": None,
                    "pais_destino": None,
                    "cultivos": item.get("cultivos_mencionados", []),
                    "url": item.get("item_url"),
                    "pdf_url": item.get("pdf_url"),
                    "chunk_index": idx,
                    "total_chunks": len(partes),
                    "texto": parte,
                }
            )
    return chunks, pendientes


def build_chunks_noticias(items: list[dict]) -> list[dict]:
    chunks = []
    for item in items:
        url = item.get("url", "")
        slug = url.rstrip("/").split("/")[-1]
        texto = item.get("cuerpo", "")
        if not texto.strip():
            continue
        partes = chunk_text(texto)
        for idx, parte in enumerate(partes):
            chunks.append(
                {
                    "chunk_id": f"noticia:{url}:{idx}",
                    "fuente": "noticia",
                    "documento_id": url,
                    "titulo": item.get("titulo"),
                    "tipo_norma": "Noticia/Comunicado",
                    "organismo_emisor": "SENASA",
                    "numero_norma": None,
                    "anio": None,
                    "fecha": item.get("fecha"),
                    "fecha_iso": item.get("fecha_iso"),
                    "pais_destino": PAIS_POR_URL.get(slug),
                    "cultivos": PRODUCTOS_POR_URL.get(slug, []),
                    "url": url,
                    "pdf_url": None,
                    "anexos_pdf": item.get("anexos_pdf", []),
                    "chunk_index": idx,
                    "total_chunks": len(partes),
                    "texto": parte,
                }
            )
    return chunks


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repositorio", default="../data/processed/senasa_index_con_texto_completo.json")
    parser.add_argument("--noticias", default="../data/raw/argentina_noticias_index.json")
    parser.add_argument("--textos-dir", default="../data/processed/textos")
    parser.add_argument("--out", default="../data/processed/chunks.json")
    args, _unknown = parser.parse_known_args()

    repositorio_path = SCRIPT_DIR / args.repositorio
    noticias_path = SCRIPT_DIR / args.noticias
    textos_dir = SCRIPT_DIR / args.textos_dir
    out_path = SCRIPT_DIR / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)

    chunks_repositorio, pendientes = [], 0
    if repositorio_path.exists():
        items_repo = json.loads(repositorio_path.read_text(encoding="utf-8"))
        chunks_repositorio, pendientes = build_chunks_repositorio(items_repo, textos_dir)
    else:
        print(f"[aviso] no se encontró {repositorio_path} -- corré extract_text_local.py primero. Sigo solo con noticias.")

    chunks_noticias = []
    if noticias_path.exists():
        items_noticias = json.loads(noticias_path.read_text(encoding="utf-8"))
        chunks_noticias = build_chunks_noticias(items_noticias)
    else:
        print(f"[aviso] no se encontró {noticias_path}")

    todos = chunks_repositorio + chunks_noticias
    out_path.write_text(json.dumps(todos, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nChunks del Repositorio: {len(chunks_repositorio)} (de documentos con texto disponible)")
    print(f"Documentos del Repositorio pendientes de texto (correr extract_text_local.py): {pendientes}")
    print(f"Chunks de noticias: {len(chunks_noticias)}")
    print(f"Total: {len(todos)} chunks")
    print(f"Guardado en: {out_path.resolve()}")


if __name__ == "__main__":
    main()
