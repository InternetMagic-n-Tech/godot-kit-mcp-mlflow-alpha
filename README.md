# Godot `kit` MCP/ACP Suite

This project is a demo how to setup a MCP/ACP coding loop with godot and how to measure those results using ML-Flow & Local Llama Models.

## Setup

 - Download as zip `https://github.com/KenneyNL/Starter-Kit-Match-3/tree/4ddb3d2a50cbf247c79cafe9e7884d7d8f99c012` extract contents to `Starter-Kit-Match-3-org/` into the repo root
 - Copy `Starter-Kit-Match-3-org/` to `Starter-Kit-Match-3/`.  From the new folder `git init; git add .; git commit -m "Init"`
 - Install `kit` from [kit github](https://github.com/mark3labs/kit) `curl -fsSL https://raw.githubusercontent.com/mark3labs/kit/master/install.sh | bash -s -- --version v0.113.0 --no-provider-check`
 - Install `mlflow` using `git` & `docker`
```
git clone --depth 1 --filter=blob:none --sparse https://github.com/mlflow/mlflow.git
cd mlflow
git sparse-checkout set docker-compose
cd docker-compose
cp .env.dev.example .env
```
 - Create `mlflow/docker-compose/assistant_config.json` with contents `{"providers": { "mlflow_gateway": { "selected": true, "model": "Local" } } }`
 - Change `mlflow/docker-compose/docker-compose.yml`
```
services:
  postgres:
...
    volumes:
      # Resolves relative to this compose file (mlflow/docker-compose/),
      # so ../../ lands in the folder you run the command from.
      - ../../docker/volumes/postgres:/var/lib/postgresql/data
...
  storage:
...
    user: "${UID:-1000}:${GID:-1000}"
    volumes:
      - ../../docker/volumes/storage:/data
...
  mlflow:
...
    ports:
      - "${MLFLOW_PORT}:${MLFLOW_PORT}"
...
    environment:
...
      MLFLOW_ENABLE_REMOTE_ASSISTANT: "true"
      MLFLOW_ENABLE_ASSISTANT_SANDBOX: "true"
      OLLAMA_HOST: ${OLLAMA_HOST}
      OPENAI_API_BASE: ${OPENAI_API_BASE}
...
    volumes:
...
      - /var/run/docker.sock:/var/run/docker.sock
      - ./assistant_config.json:/root/.mlflow/assistant/config.json
...
    command:
      - /bin/bash
      - -c
      - |
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq && apt-get install -y -qq curl socat docker.io
        pip install --no-cache-dir psycopg2-binary boto3 "mlflow[genai,auth]"
        socat TCP-LISTEN:11434,fork,reuseaddr TCP:host.docker.internal:11434 &
        mlflow server \
          --backend-store-uri "${MLFLOW_BACKEND_STORE_URI}" \
          --artifacts-destination "${MLFLOW_ARTIFACTS_DESTINATION}" \
          --serve-artifacts \
          --host "${MLFLOW_HOST}" \
          --port "${MLFLOW_PORT}"
...
    extra_hosts://host.docker.internal:11434
      - "host.docker.internal:host-gateway"
...
```
 - Create `mlflow/docker-compose/.env`
```
# PostgreSQL
POSTGRES_USER=mypguser
POSTGRES_PASSWORD=mysecurepassword
POSTGRES_DB=mlflow
PGPORT=5432

# --- RustFS (S3-compatible artifact storage) ---
AWS_ACCESS_KEY_ID=s3admin
AWS_SECRET_ACCESS_KEY=s3mysecurekey
AWS_DEFAULT_REGION=us-east-1
RUSTFS_CONSOLE_ENABLE=true
S3_BUCKET=mlflow
MLFLOW_S3_ENDPOINT_URL=http://storage:9000
MLFLOW_ARTIFACTS_DESTINATION=s3://${S3_BUCKET}

# --- MLflow server ---
MLFLOW_VERSION=v3.16.1
MLFLOW_HOST=0.0.0.0
MLFLOW_PORT=5000
MLFLOW_BACKEND_STORE_URI=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:${PGPORT}/${POSTGRES_DB}

MLFLOW_AUTH_DISABLE=true
MLFLOW_ENABLE_REMOTE_ASSISTANT=true
OLLAMA_MODEL=gemma4:26b # your preferred model
OLLAMA_HOST="http://host.docker.internal:11434"
OPENAI_API_BASE="http://host.docker.internal:11434/v1"
OPENAI_API_KEY=none
```
 - Run `mkdir -p docker/volumes/postgres docker/volumes/storage; chmod -R 777 docker/volumes/storage; sudo chown -R 1000:1000 docker/volumes/storage`
 - Run from Repo Root `docker compose -f mlflow/docker-compose/docker-compose.yml up`
 - Use `ollama`/`llama.cpp` to pull `mxbai-embed-large` and/or `nomic-embed-text`
 - Use `ollama`/`llama.cpp` to pull your preferred local model i.e. `gemma4:26b` or `qwen3:30b`
 - Create `.env` in repo-root if you need custom `GODOT_PATH` and/or `PATH_PREFIX`
 - Now you can run `npm run setup` (or `(export PATH="$HOME/my-bins/node24/bin:$PATH" && npm run setup)` if you are using `PATH_PREFIX`)
 - With the mlflow server running `http://localhost:5000` 
   - Change Settings: Go to Settings > LLM Connections > Create
      - Key Name: `None`
      - Provider: `Ollama`
      - API Key: `none`
      - API Base URL: `http://host.docker.internal:11434/v1`
    - Add AI Gateway: Go to Home > AI Gateway > Create
      - Name: `Local`
      - Usage Tracking: (optional)
      - Provider: `Ollama`
      - Model: `gemma4:26b` (or your preferred model)
      - Connections: `Use Existing API Key`
      - API Key: `None`
    - If you used a different `Name` that wasn't `Local` you'll need to change `mlflow/docker-compose/assistant_config.json`
 - Python Venv: `python3 -m venv venv`
 - Python Venv: `python3 -m venv godot-rag-venv`
 - Install UV: `curl -LsSf https://astral.sh/uv/install.sh | sh`

 ## Environment Variables

 - `GODOT_PATH`: Path to godot binary if not on `$PATH`.  For me it's `~/MyAppContainers/Godot_v4.6.x86_64`
 - `PATH_PREFIX`: Path prefix if you have multiple versions of node installed and you need to override the node version.  For me it's `~/my-bins/node24/bin`
 - `ML_FLOW_ORIGIN`: For creation scripts if `mlflow` server instance

 
 ### Yargs & Environment Variables

 Check any yargs binding utilities for default overrides.
