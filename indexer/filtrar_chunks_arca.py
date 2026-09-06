"""
Extrae solo los chunks con fuente == "arca" de chunks.json (generado por
chunking.py) a un archivo aparte, para poder indexarlos en Pinecone SIN
tocar ni regenerar chunks_completo.json (que ya tiene los ~1841 chunks de
SENASA + noticias funcionando en producción).

Por qué separado en vez de fusionar los archivos: upsert_records de
Pinecone es aditivo por _id -- indexar solo estos 18 chunks nuevos no
borra ni modifica nada de lo que ya está indexado. Es el camino de menor
riesgo mientras no se resuelva por qué chunking.py no encuentra el texto
del Repositorio (ver conversación: no existe carpeta data/processed/textos).

Uso (desde la carpeta indexer/):
    python filtrar_chunks_arca.py
"""

import json
from pathlib import Path

try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    SCRIPT_DIR = Path.cwd()

ENTRADA = SCRIPT_DIR / "../data/processed/chunks.json"
SALIDA = SCRIPT_DIR / "../data/processed/chunks_arca_solo.json"

todos = json.loads(ENTRADA.read_text(encoding="utf-8"))
solo_arca = [c for c in todos if c.get("fuente") == "arca"]

SALIDA.write_text(json.dumps(solo_arca, ensure_ascii=False, indent=2), encoding="utf-8")

print(f"Chunks de ARCA encontrados: {len(solo_arca)}")
print(f"Guardado en: {SALIDA.resolve()}")
print("\nSiguiente paso:")
print("  python index_pinecone.py --chunks ../data/processed/chunks_arca_solo.json")
