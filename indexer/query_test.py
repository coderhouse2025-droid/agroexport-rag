"""
Prueba rápida de retrieval: hace una consulta de ejemplo contra el índice de
Pinecone y muestra los chunks más relevantes, para confirmar que el indexado
funciona antes de construir el backend (paso 6 del README).

Uso:
    export PINECONE_API_KEY="tu-api-key"
    python query_test.py --pregunta "requisitos para exportar soja a China"
"""

import argparse
import os
from pathlib import Path

from pinecone import Pinecone

try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    SCRIPT_DIR = Path.cwd()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pregunta", default="requisitos fitosanitarios para exportar soja a China")
    parser.add_argument("--index-name", default="agroexport-granos")
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--api-key", default=None)
    args, _unknown = parser.parse_known_args()

    api_key = args.api_key or os.environ.get("PINECONE_API_KEY")
    if not api_key:
        raise SystemExit("Falta PINECONE_API_KEY (--api-key o variable de entorno)")

    pc = Pinecone(api_key=api_key)
    index = pc.Index(args.index_name)

    resultados = index.search(
        namespace=args.namespace,
        query={"inputs": {"text": args.pregunta}, "top_k": args.top_k},
    )

    print(f"Pregunta: {args.pregunta}\n")
    hits = resultados.get("result", {}).get("hits", [])
    if not hits:
        print("Sin resultados. Si acabás de indexar, esperá ~10-20 segundos y probá de nuevo.")
        return

    for i, hit in enumerate(hits, 1):
        campos = hit["fields"]
        score = hit["_score"]
        print(f"--- Resultado {i} (score: {score:.4f}) ---")
        print(f"Título: {campos.get('titulo')}")
        print(f"Fuente: {campos.get('fuente')} | Tipo: {campos.get('tipo_norma')} | N°: {campos.get('numero_norma')} | Año: {campos.get('anio')}")
        print(f"Cultivos: {campos.get('cultivos')} | País: {campos.get('pais_destino')}")
        print(f"Texto: {campos.get('texto', '')[:300]}...")
        print()


if __name__ == "__main__":
    main()
