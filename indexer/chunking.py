"""
Chunking unificado: junta el Repositorio Institucional SENASA, las noticias
de argentina.gob.ar y la normativa de ARCA en un solo esquema de metadata,
listo para indexar.

Esquema común por chunk:
    chunk_id, fuente ("repositorio" | "noticia" | "arca"), documento_id, titulo,
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
  - ARCA (arca_normativa.py): igual que noticias, ya viene con 'cuerpo' en
    texto plano (no hace falta extract_text_local.py). cultivos y
    pais_destino quedan vacíos por ahora -- normativa de ARCA suele ser
    de alcance general, no por país/cultivo específico. Se usa
    fecha_publicacion_boletin como fecha/fecha_iso.
  - vigente queda como None ("desconocido") en las tres fuentes -- determinar
    vigencia real es un paso aparte (parte del roadmap del README, sección 5).
  - Si un documento del Repositorio no tiene texto completo persistido
    (ver extract_text_local.py), se listra como documento pendiente y no se
    generan chunks para él, en vez de fallar.

Uso:
    python chunking.py \
        --repositorio ../data/processed/senasa_index_con_texto_completo.json \
        --noticias ../data/raw/argentina_noticias_index.json \
        --arca ../data/raw/arca_normativa_index.json \
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


# --- Detección de vigencia (versionado de normas) ---
#
# Alcance deliberadamente conservador: solo marcamos vigente=False cuando
# encontramos, dentro del propio corpus indexado, una oración de otra norma
# que dice explícitamente "derógase/sustitúyese/déjase sin efecto la
# Resolución/Decreto N° X/AAAA" y ese N°/tipo/año coincide con una norma que
# ya tenemos indexada. NO tratamos de inferir vigencia por ningún otro medio
# (antigüedad, tema, etc.) -- así evitamos falsos positivos que serían
# activamente engañosos para alguien tomando una decisión de exportación.
# Todo lo que no tiene evidencia textual de derogación queda vigente=None
# ("no verificado"), nunca vigente=True: no tenemos forma de confirmar que
# una norma sigue vigente, solo evidencia de que fue derogada cuando la hay.
_VERBOS_DEROGACION = r"(?:der[oó]gase|der[oó]ganse|abr[oó]gase|sustit[uú]yese|queda(?:n)? sin efecto|d[eé]jase sin efecto|quedan? derogad[oa]s?)"
_REF_NORMA = r"(Resoluci[oó]n|Decreto|Disposici[oó]n)(?:[^.\n]{0,40}?)N[°ºo]\s*0*(\d{1,5})\s*/\s*(\d{2,4})"
_PATRON_DEROGACION = re.compile(
    _VERBOS_DEROGACION + r"[^.\n]{0,120}?" + _REF_NORMA, re.IGNORECASE
)


def _normalizar_anio(anio_str: str) -> int | None:
    """'08' -> ambiguo, no lo resolvemos (devuelve None); '2008' -> 2008.
    Preferimos no adivinar el siglo de un año de 2 dígitos antes que
    acertar mal la mitad de las veces."""
    if len(anio_str) == 4:
        return int(anio_str)
    return None


def detectar_derogaciones(documentos: list[dict]) -> dict:
    """documentos: lista de {"documento_id", "tipo_norma", "numero_norma",
    "anio", "texto"} de TODAS las fuentes ya unificadas (repositorio + arca;
    noticias se excluyen como blanco porque no tienen numero_norma propio,
    aunque sí se escanean como posible fuente de una derogación).

    Devuelve {documento_id_derogado: {"vigente": False, "derogada_por_id":
    ..., "derogada_por_titulo": ..., "evidencia": "<oración encontrada>"}}
    """
    # índice normado -> documento_id, para resolver la referencia encontrada
    indice = {}
    for doc in documentos:
        tipo = (doc.get("tipo_norma") or "").strip().lower()
        numero = doc.get("numero_norma")
        anio = doc.get("anio")
        if not tipo or numero is None or anio is None:
            continue
        try:
            clave = (tipo, int(str(numero).lstrip("0") or "0"), int(anio))
        except (ValueError, TypeError):
            continue
        indice[clave] = doc

    resultado = {}
    for doc in documentos:
        texto = doc.get("texto") or ""
        if not texto:
            continue
        for match in _PATRON_DEROGACION.finditer(texto):
            tipo_ref = match.group(1).strip().lower()
            numero_ref = match.group(2).lstrip("0") or "0"
            anio_ref = _normalizar_anio(match.group(3))
            if anio_ref is None:
                continue
            clave = (tipo_ref, int(numero_ref), anio_ref)
            objetivo = indice.get(clave)
            if objetivo is None or objetivo["documento_id"] == doc["documento_id"]:
                continue  # no está en nuestro corpus, o falso positivo autoreferencial
            resultado[objetivo["documento_id"]] = {
                "vigente": False,
                "derogada_por_id": doc["documento_id"],
                "derogada_por_titulo": doc.get("titulo"),
                "evidencia": match.group(0).strip(),
            }
    return resultado


CULTIVOS_CONOCIDOS = ["soja", "maíz", "maiz", "trigo", "cebada", "sorgo", "girasol"]





def _detectar_cultivos(texto: str) -> list[str]:
    """Heurística simple por palabra clave (no NLP) para poblar 'cultivos' en
    normas de ARCA -- antes quedaba siempre en [] aunque la norma fuera
    específicamente sobre soja/maíz/etc (ej. Decreto 423/2026 de retenciones),
    lo que empobrecía el panel de 'Normativa relacionada' en el frontend."""
    texto_low = texto.lower()
    encontrados = []
    for cultivo in CULTIVOS_CONOCIDOS:
        clave = "maíz" if cultivo == "maiz" else cultivo
        if cultivo in texto_low and clave not in encontrados:
            encontrados.append(clave)
    return encontrados


def build_chunks_arca(items: list[dict]) -> list[dict]:
    """Mismo patrón que build_chunks_noticias: el JSON de arca_normativa.py
    ya trae 'cuerpo' en texto plano (HTML ya limpiado), así que no hace
    falta pasar por extract_text_local.py como sí necesita el Repositorio
    SENASA (que solo tiene PDFs)."""
    chunks = []
    for item in items:
        documento_id = item.get("documento_id", item.get("url", ""))
        texto = item.get("cuerpo", "")
        if not texto.strip():
            continue
        cultivos = _detectar_cultivos(f"{item.get('titulo', '')} {texto}")
        partes = chunk_text(texto)
        for idx, parte in enumerate(partes):
            chunks.append(
                {
                    "chunk_id": f"{documento_id}:{idx}",
                    "fuente": "arca",
                    "documento_id": documento_id,
                    "titulo": item.get("titulo"),
                    "tipo_norma": item.get("tipo_norma"),
                    "organismo_emisor": item.get("organismo_emisor"),
                    "numero_norma": item.get("numero_norma"),
                    "anio": item.get("anio"),
                    "fecha": item.get("fecha_publicacion_boletin"),
                    "fecha_iso": item.get("fecha_publicacion_boletin"),
                    "pais_destino": None,
                    "cultivos": cultivos,
                    "url": item.get("url"),
                    "pdf_url": None,
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
    parser.add_argument("--arca", default="../data/raw/arca_normativa_index.json")
    parser.add_argument("--textos-dir", default="../data/processed/textos")
    parser.add_argument("--out", default="../data/processed/chunks.json")
    args, _unknown = parser.parse_known_args()

    repositorio_path = SCRIPT_DIR / args.repositorio
    noticias_path = SCRIPT_DIR / args.noticias
    arca_path = SCRIPT_DIR / args.arca
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

    chunks_arca = []
    if arca_path.exists():
        items_arca = json.loads(arca_path.read_text(encoding="utf-8"))
        chunks_arca = build_chunks_arca(items_arca)
    else:
        print(f"[aviso] no se encontró {arca_path} -- corré arca_normativa.py primero si querés incluir normativa de ARCA. Sigo sin ella.")

    todos = chunks_repositorio + chunks_noticias + chunks_arca

    # Versionado de normas: un mismo documento aparece repetido (uno por chunk_index),
    # así que armamos "documentos" (1 por documento_id, usando su primer chunk como
    # representante -- alcanza para tipo_norma/numero_norma/anio/titulo) y concatenamos
    # su texto completo para que la búsqueda de "derógase..." no se pierda si la frase
    # cae justo en el borde entre dos chunks.
    texto_por_doc = {}
    representante_por_doc = {}
    for c in todos:
        doc_id = c["documento_id"]
        texto_por_doc.setdefault(doc_id, []).append(c["texto"])
        representante_por_doc.setdefault(doc_id, c)
    documentos = [
        {
            "documento_id": doc_id,
            "titulo": rep.get("titulo"),
            "tipo_norma": rep.get("tipo_norma"),
            "numero_norma": rep.get("numero_norma"),
            "anio": rep.get("anio"),
            "texto": "\n".join(texto_por_doc[doc_id]),
        }
        for doc_id, rep in representante_por_doc.items()
    ]
    derogaciones = detectar_derogaciones(documentos)
    for c in todos:
        info = derogaciones.get(c["documento_id"])
        if info:
            c["vigente"] = False
            c["derogada_por_id"] = info["derogada_por_id"]
            c["derogada_por_titulo"] = info["derogada_por_titulo"]
            c["evidencia_derogacion"] = info["evidencia"]
        else:
            c["vigente"] = None  # no verificado -- no implica que SÍ esté vigente, ver docstring de detectar_derogaciones
            c["derogada_por_id"] = None
            c["derogada_por_titulo"] = None
            c["evidencia_derogacion"] = None

    out_path.write_text(json.dumps(todos, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nChunks del Repositorio: {len(chunks_repositorio)} (de documentos con texto disponible)")
    print(f"Documentos del Repositorio pendientes de texto (correr extract_text_local.py): {pendientes}")
    print(f"Chunks de noticias: {len(chunks_noticias)}")
    print(f"Chunks de ARCA: {len(chunks_arca)}")
    print(f"Total: {len(todos)} chunks")
    if derogaciones:
        print(f"Normas marcadas como derogadas (evidencia textual encontrada en el propio corpus): {len(derogaciones)}")
        for doc_id, info in derogaciones.items():
            print(f"  - {representante_por_doc[doc_id].get('titulo')}  ->  derogada por: {info['derogada_por_titulo']}")
    else:
        print("Normas marcadas como derogadas: 0 (ninguna coincidencia encontrada esta corrida)")
    print(f"Guardado en: {out_path.resolve()}")


if __name__ == "__main__":
    main()
