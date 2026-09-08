"""
Extrae solo los chunks con fuente == "noticia" de chunks.json (generado por
chunking.py) a un archivo aparte, para indexarlos en Pinecone SIN tocar
chunks_completo.json ni re-subir los 82 chunks de ARCA de nuevo.

upsert_records es idempotente por _id -- reindexar las 3 noticias viejas
junto con las 2 nuevas no duplica nada, solo actualiza (sin cambios) las
viejas y agrega las nuevas.

Uso (desde la carpeta indexer/):
    python filtrar_chunks_noticias.py
"""

import json
from pathlib import Path

try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    SCRIPT_DIR = Path.cwd()

ENTRADA = SCRIPT_DIR / "../data/processed/chunks.json"
SALIDA = SCRIPT_DIR / "../data/processed/chunks_noticias_solo.json"

todos = json.loads(ENTRADA.read_text(encoding="utf-8"))
solo_noticias = [c for c in todos if c.get("fuente") == "noticia"]

SALIDA.write_text(json.dumps(solo_noticias, ensure_ascii=False, indent=2), encoding="utf-8")

print(f"Chunks de noticias encontrados: {len(solo_noticias)}")
print(f"Guardado en: {SALIDA.resolve()}")
print("\nSiguiente paso:")
print("  python index_pinecone.py --chunks ../data/processed/chunks_noticias_solo.json")
