#!/usr/bin/env python3
"""
index_godot_docs.py

Reads a chunks JSON file (produced by chunk_godot_docs.py), embeds each
chunk's text using a local Ollama embedding model, and stores the vectors
in a persistent local Chroma collection for later similarity search.

Requires:
    pip install chromadb requests --break-system-packages

Assumes Ollama is running locally with an embedding model pulled, e.g.:
    ollama pull nomic-embed-text

Usage:
    python3 index_godot_docs.py chunks-4.6.json --collection godot_4_6
    python3 index_godot_docs.py chunks-4.6.json --collection godot_4_6 --db-path ./godot_docs_db
    python3 index_godot_docs.py chunks-4.6.json --collection godot_4_6 --query "how do I detect a node's global position"
"""

import argparse
import json
import sys
import time
from pathlib import Path

try:
    import chromadb
except ImportError:
    print("Missing dependency: chromadb. Install with:", file=sys.stderr)
    print("  pip install chromadb requests --break-system-packages", file=sys.stderr)
    sys.exit(1)

try:
    import requests
except ImportError:
    print("Missing dependency: requests. Install with:", file=sys.stderr)
    print("  pip install chromadb requests --break-system-packages", file=sys.stderr)
    sys.exit(1)


def get_ollama_embedding(text: str, model: str, ollama_url: str) -> list:
    """Call Ollama's /api/embeddings endpoint for a single text chunk."""
    resp = requests.post(
        f"{ollama_url}/api/embeddings",
        json={"model": model, "prompt": text},
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    if "embedding" not in data:
        raise RuntimeError(f"Unexpected response from Ollama: {data}")
    return data["embedding"]


def batch_embed(chunks, model, ollama_url, batch_log_every=25):
    """
    Ollama's /api/embeddings endpoint (as of this writing) embeds one prompt
    per request -- there's no batch endpoint guaranteed across versions, so
    we call it once per chunk and report progress since this is the slow
    part of indexing.
    """
    embeddings = []
    failures = []
    for i, chunk in enumerate(chunks, 1):
        try:
            vec = get_ollama_embedding(chunk["text"], model, ollama_url)
            embeddings.append(vec)
        except Exception as e:
            print(f"  [warn] embedding failed for chunk '{chunk['id']}': {e}", file=sys.stderr)
            failures.append(chunk["id"])
            embeddings.append(None)
        if i % batch_log_every == 0:
            print(f"  ...embedded {i}/{len(chunks)} chunks")
    return embeddings, failures


def build_index(chunks_path: Path, db_path: str, collection_name: str, model: str, ollama_url: str):
    chunks = json.loads(chunks_path.read_text(encoding="utf-8"))
    print(f"Loaded {len(chunks)} chunks from {chunks_path}")

    print(f"Embedding chunks using Ollama model '{model}' at {ollama_url} ...")
    start = time.time()
    embeddings, failures = batch_embed(chunks, model, ollama_url)
    elapsed = time.time() - start
    print(f"Embedding done in {elapsed:.1f}s ({len(failures)} failures)")

    # Drop any chunks whose embedding failed rather than corrupting the index.
    good_chunks, good_embeddings = [], []
    for chunk, emb in zip(chunks, embeddings):
        if emb is not None:
            good_chunks.append(chunk)
            good_embeddings.append(emb)

    if not good_chunks:
        print("Error: no chunks were successfully embedded. Is Ollama running and is the model pulled?", file=sys.stderr)
        sys.exit(1)

    client = chromadb.PersistentClient(path=db_path)
    # Recreate the collection cleanly each run so re-indexing doesn't leave
    # stale/duplicate entries from a previous run.
    try:
        client.delete_collection(collection_name)
    except Exception:
        pass
    collection = client.create_collection(collection_name)

    ids = [c["id"] for c in good_chunks]
    documents = [c["text"] for c in good_chunks]
    metadatas = [
        {
            "source_path": c.get("source_path", ""),
            "class_name": c.get("class_name") or "",
            "heading": c.get("heading", ""),
        }
        for c in good_chunks
    ]

    # Chroma has a per-call batch limit depending on version/backend; add in
    # chunks of 500 to stay safely under it for large doc sets.
    BATCH = 500
    for start_idx in range(0, len(ids), BATCH):
        end_idx = start_idx + BATCH
        collection.add(
            ids=ids[start_idx:end_idx],
            embeddings=good_embeddings[start_idx:end_idx],
            documents=documents[start_idx:end_idx],
            metadatas=metadatas[start_idx:end_idx],
        )

    print(f"Indexed {len(good_chunks)} chunks into collection '{collection_name}' at {db_path}")
    if failures:
        print(f"Note: {len(failures)} chunks failed to embed and were skipped: {failures[:5]}{' ...' if len(failures) > 5 else ''}")

    return client, collection


def run_query(collection, query: str, model: str, ollama_url: str, top_k: int = 5):
    query_embedding = get_ollama_embedding(query, model, ollama_url)
    results = collection.query(query_embeddings=[query_embedding], n_results=top_k)

    print(f"\nTop {top_k} results for: {query!r}\n")
    ids = results["ids"][0]
    docs = results["documents"][0]
    metas = results["metadatas"][0]
    dists = results.get("distances", [[None] * len(ids)])[0]

    for i, (cid, doc, meta, dist) in enumerate(zip(ids, docs, metas, dists), 1):
        print(f"[{i}] {cid}  (distance: {dist:.4f})" if dist is not None else f"[{i}] {cid}")
        print(f"    class: {meta.get('class_name') or '-'}  source: {meta.get('source_path')}")
        snippet = doc[:300].replace("\n", " ")
        print(f"    {snippet}{'...' if len(doc) > 300 else ''}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("chunks_json", help="Path to chunks JSON produced by chunk_godot_docs.py")
    parser.add_argument("--collection", required=True, help="Name for the Chroma collection, e.g. godot_4_6")
    parser.add_argument("--db-path", default="./godot_docs_db", help="Local directory for the persistent Chroma DB")
    parser.add_argument("--model", default="nomic-embed-text", help="Ollama embedding model name (default: nomic-embed-text)")
    parser.add_argument("--ollama-url", default="http://localhost:11434", help="Ollama base URL")
    parser.add_argument("--query", default=None, help="Optional: run a test query against the index after building it")
    parser.add_argument("--top-k", type=int, default=5, help="Number of results to return for --query")
    args = parser.parse_args()

    chunks_path = Path(args.chunks_json)
    if not chunks_path.is_file():
        print(f"Error: {chunks_path} not found", file=sys.stderr)
        sys.exit(1)

    client, collection = build_index(chunks_path, args.db_path, args.collection, args.model, args.ollama_url)

    if args.query:
        run_query(collection, args.query, args.model, args.ollama_url, args.top_k)
    else:
        print("\nIndex built. Run again with --query \"your question\" to test retrieval,")
        print("or point an MCP server at this same --db-path / --collection to serve it live.")


if __name__ == "__main__":
    main()
