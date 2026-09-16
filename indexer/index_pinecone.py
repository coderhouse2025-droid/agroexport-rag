"""
Indexado: sube los chunks generados por chunking.py a Pinecone, usando
inferencia integrada (Pinecone calcula el embedding de cada chunk al
insertarlo, con el modelo llama-text-embed-v2 de NVIDIA -- mismo modelo que
usa Norma-AR).

Por qué inferencia integrada y no generar embeddings a mano: Pinecone ofrece
`create_index_for_model` + `upsert_records`, que reciben el texto plano y
hacen el embedding del lado del servidor. Evita instalar un SDK de NVIDIA
aparte y evita tener que mantener embeddings recalculados si algún día se
cambia de modelo (se re-indexa con otro `embed.model` y listo).

NOTA 13/09/2026: la cuota gratuita de este modelo es de 5.000.000 tokens de
embedding POR MES por organización -- se agota fácil si se reindexa el
corpus completo varias veces en una sola sesión de trabajo (cada reindex
recalcula el embedding de TODOS los chunks, no solo los que cambiaron).
Evaluamos pasar a generar embeddings propios con un proveedor gratis aparte
(Google Gemini) para no depender de esta cuota, pero se decidió por ahora
resolverlo de otra forma: procesar y validar TODO el pipeline de datos
localmente (chunks.json completo y revisado) ANTES de correr este script,
para subir a Pinecone una sola vez por sesión de trabajo en vez de
iterativamente. Ver README, sección de pendientes, para más contexto.

Requiere una cuenta de Pinecone (gratis, plan Starter alcanza sobrado para
este volumen: ~2000 chunks contra 100k vectores y 5M tokens/mes gratis) y
una API key: https://app.pinecone.io/ -> API Keys.

Uso:
    export PINECONE_API_KEY="tu-api-key"
    python index_pinecone.py
    python index_pinecone.py --chunks ../data/processed/chunks_completo.json   # override puntual, ej. re-subir un snapshot viejo
"""

import argparse
import json
import os
import time
from pathlib import Path

from pinecone import Pinecone

try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    SCRIPT_DIR = Path.cwd()

# límite documentado del modelo llama-text-embed-v2 en la API de upsert_records
BATCH_SIZE = 90  # un poco por debajo del máximo (96) para dejar margen


def cargar_chunks(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))


def a_registro_pinecone(chunk: dict) -> dict:
    """Convierte un chunk al formato que espera upsert_records: necesita un
    campo '_id' y el campo de texto mapeado ('texto', ver field_map al crear
    el índice). El resto de los campos quedan como metadata consultable
    (fuente, tipo_norma, pais_destino, cultivos, etc.), filtrando los que
    sean None porque Pinecone no acepta valores null en metadata.

    FIX 13/09/2026: faltaban acá los 4 campos de versionado de normas
    (vigente, derogada_por_id, derogada_por_titulo, evidencia_derogacion)
    que chunking.py ya calculaba desde la sesión anterior -- estaban bien
    calculados en chunks.json pero nunca llegaban a Pinecone, así que
    api/chat.js nunca los recibía (siempre None/undefined en producción,
    aunque el código de detección funcionara bien)."""
    registro = {"_id": chunk["chunk_id"], "texto": chunk["texto"]}
    for campo in (
        "fuente", "documento_id", "titulo", "tipo_norma", "organismo_emisor",
        "numero_norma", "anio", "fecha", "fecha_iso", "pais_destino",
        "cultivos", "url", "chunk_index", "total_chunks",
        "vigente", "derogada_por_id", "derogada_por_titulo", "evidencia_derogacion",
    ):
        valor = chunk.get(campo)
        if valor is not None:
            registro[campo] = valor
    return registro


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--chunks", default="../data/processed/chunks.json")
    parser.add_argument("--index-name", default="agroexport-granos")
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--cloud", default="aws")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--api-key", default=None, help="Si no se pasa, se lee de la variable de entorno PINECONE_API_KEY")
    args, _unknown = parser.parse_known_args()

    api_key = args.api_key or os.environ.get("PINECONE_API_KEY")
    if not api_key:
        raise SystemExit(
            "Falta la API key de Pinecone. Pasala con --api-key o definí la variable "
            "de entorno PINECONE_API_KEY (conseguila en https://app.pinecone.io/ -> API Keys)."
        )

    chunks_path = SCRIPT_DIR / args.chunks
    chunks = cargar_chunks(chunks_path)
    print(f"{len(chunks)} chunks cargados de {chunks_path}")

    pc = Pinecone(api_key=api_key)

    indices_existentes = [i["name"] for i in pc.list_indexes()]
    if args.index_name not in indices_existentes:
        print(f"Creando índice '{args.index_name}' con inferencia integrada (llama-text-embed-v2)...")
        pc.create_index_for_model(
            name=args.index_name,
            cloud=args.cloud,
            region=args.region,
            embed={
                "model": "llama-text-embed-v2",
                "field_map": {"text": "texto"},
            },
        )
        # el índice tarda unos segundos en quedar listo tras crearse
        while not pc.describe_index(args.index_name).status["ready"]:
            time.sleep(2)
        print("Índice listo.")
    else:
        print(f"El índice '{args.index_name}' ya existe, se reutiliza (upsert = crea o actualiza por _id).")

    index = pc.Index(args.index_name)

    # Filtro defensivo: un chunk con 'texto' vacío/solo-espacios hace que Pinecone
    # rechace TODO el lote al que pertenece (no solo ese registro) con un 400
    # "Missing field_mapping field 'text'". Detectado 15/09/2026 con un chunk del
    # Repositorio que quedó vacío tras el chunking (probablemente residuo de un OCR
    # muy pobre en ese documento puntual). Se saltea acá con aviso, en vez de que
    # tumbe la corrida completa por un solo chunk.
    chunks_validos = [c for c in chunks if c.get("texto", "").strip()]
    saltados = len(chunks) - len(chunks_validos)
    if saltados:
        print(f"[aviso] {saltados} chunk(s) con texto vacío, se saltean (no se suben a Pinecone):")
        for c in chunks:
            if not c.get("texto", "").strip():
                print(f"  - {c['chunk_id']}")

    registros = [a_registro_pinecone(c) for c in chunks_validos]
    total = len(registros)
    subidos = 0
    for i in range(0, total, BATCH_SIZE):
        lote = registros[i : i + BATCH_SIZE]
        # el plan gratis de Pinecone limita a 250k tokens/minuto para este
        # modelo -- si lo pisamos, esperamos con backoff exponencial y
        # reintentamos el MISMO lote (upsert es idempotente por _id, no
        # duplica nada si se reintenta)
        intentos = 0
        while True:
            try:
                index.upsert_records(namespace=args.namespace, records=lote)
                break
            except Exception as e:
                if "RESOURCE_EXHAUSTED" not in str(e) and "429" not in str(e):
                    raise
                intentos += 1
                if intentos > 8:
                    raise
                espera = min(60, 10 * intentos)
                print(f"  rate limit alcanzado, esperando {espera}s antes de reintentar (intento {intentos})...")
                time.sleep(espera)
        subidos += len(lote)
        print(f"  subidos {subidos}/{total}...")
        time.sleep(3)  # pausa proactiva entre lotes para no pisar el límite tan seguido

    print(f"\n{subidos} chunks indexados en Pinecone (índice: {args.index_name}, namespace: {args.namespace})")
    print("Nota: la inferencia integrada tarda unos segundos en reflejarse en las búsquedas -- si consultás")
    print("inmediatamente después puede devolver 0 resultados, esperá ~10-20 segundos y probá de nuevo.")


if __name__ == "__main__":
    main()
