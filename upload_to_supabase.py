"""Script auxiliar para upload dos dados extraídos para o bucket privado do Supabase.

Uso:
    python upload_to_supabase.py --key <SERVICE_ROLE_KEY>

Ou informe a chave quando solicitada no terminal.
A chave Service Role pode ser obtida no painel do Supabase em:
Project Settings > API > Project API keys > service_role (secret).
"""

import argparse
import json
import mimetypes
import sys
import urllib.error
import urllib.request
from pathlib import Path

SUPABASE_URL = "https://rxtlchjllpjzyecpzbeu.supabase.co"
BUCKET_NAME = "study-materials"


def upload_file(supabase_url: str, bucket: str, file_path: Path, dest_path: str, secret_key: str):
    url = f"{supabase_url.rstrip('/')}/storage/v1/object/{bucket}/{dest_path.lstrip('/')}"
    data = file_path.read_bytes()
    mime_type, _ = mimetypes.guess_type(str(file_path))
    mime_type = mime_type or "application/json"

    headers = {
        "Authorization": f"Bearer {secret_key}",
        "apiKey": secret_key,
        "Content-Type": mime_type,
        "x-upsert": "true",
    }

    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as response:
            return response.status in (200, 201)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        print(f"  [ERRO] Falha ao enviar {dest_path}: {e.code} - {error_body}")
        return False
    except Exception as e:
        print(f"  [ERRO] Falha de conexao ao enviar {dest_path}: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Upload dos dados extraídos para o Supabase Storage")
    parser.add_argument("--key", help="Supabase service_role key (secret)")
    parser.add_argument("--data-dir", default=str(Path(__file__).parent / "data"), help="Pasta com os arquivos gerados")
    args = parser.parse_args()

    key = args.key
    if not key:
        print("Digite a chave service_role do Supabase (Project Settings > API):")
        key = input("Chave: ").strip()

    if not key:
        print("Erro: A chave service_role é obrigatória.")
        sys.exit(1)

    data_dir = Path(args.data_dir)
    manifest_file = data_dir / "manifest.json"
    index_file = data_dir / "question-index.json"
    subjects_dir = data_dir / "subjects"

    if not manifest_file.exists():
        print(f"Erro: Arquivo {manifest_file} não encontrado. Execute extractor.py primeiro.")
        sys.exit(1)

    with manifest_file.open("r", encoding="utf-8") as f:
        manifest = json.load(f)

    totals = manifest.get("totals", {})
    print(f"Iniciando envio para o bucket '{BUCKET_NAME}'...")
    print(f"Total: {totals.get('questions', 0)} questoes, {totals.get('materials', 0)} materiais, {totals.get('subjects', 0)} disciplinas.\n")

    resumos_file = data_dir / "resumos.json"
    files_to_upload = [
        (manifest_file, "manifest.json"),
        (index_file, "question-index.json"),
    ]
    if resumos_file.exists():
        files_to_upload.append((resumos_file, "resumos.json"))

    for subj_file in sorted(subjects_dir.glob("*.json")):
        files_to_upload.append((subj_file, f"subjects/{subj_file.name}"))

    success = 0
    total = len(files_to_upload)

    for local_path, dest_path in files_to_upload:
        if not local_path.exists():
            print(f"[-] Pulando {dest_path} (arquivo local não existe)")
            continue
        size_kb = local_path.stat().st_size / 1024
        print(f"Enviando {dest_path} ({size_kb:.1f} KB)...", end=" ", flush=True)
        if upload_file(SUPABASE_URL, BUCKET_NAME, local_path, dest_path, key):
            print("OK")
            success += 1

    print(f"\nFinalizado: {success}/{total} arquivos enviados com sucesso para o bucket '{BUCKET_NAME}'.")
    if success == total:
        print(f"O site agora refletira a nova extracao com {totals.get('questions', 0):,} questoes ao recarregar a pagina.")


if __name__ == "__main__":
    main()
