Forks only 🔱 please


# Godot `kit` MCP/ACP Ollam/Llama Suite

This project is a demo how to setup a MCP/ACP coding loop with godot and how to measure those results using ML-Flow & Local Llama Models.

`llama.cpp` coming soon 🔱❗


## Setup

 - Download as zip `https://github.com/KenneyNL/Starter-Kit-Match-3/tree/4ddb3d2a50cbf247c79cafe9e7884d7d8f99c012` extract contents to `Starter-Kit-Match-3-org/` into the repo root
 - Install `kit` from [kit github](https://github.com/mark3labs/kit) `curl -fsSL https://raw.githubusercontent.com/mark3labs/kit/master/install.sh | bash -s -- --version v0.136.0 --no-provider-check`
 - Install `mlflow` using `git` & `docker`
```
git clone --depth 1 --filter=blob:none --sparse https://github.com/mlflow/mlflow.git
cd mlflow
git fetch origin tag v3.17.2 --no-tags
git checkout v3.17.2
git sparse-checkout set docker-compose
cd docker-compose
cp .env.dev.example .env
```
 - Create **assistant_config.json** with `patch -p1 < patches/mlflow/docker-compose/assistant_config.json.patch`
    - Update this patch using `diff -u /dev/null mlflow/docker-compose/assistant_config.json > patches/mlflow/docker-compose/assistant_config.json.patch`
 - Change **docker-compose** `mlflow/docker-compose/docker-compose.yml` with `git apply patches/mlflow/docker-compose/docker-compose.yml.patch`
    - Update this patch using `diff -u mlflow/docker-compose/archive-docker-compose.yml mlflow/docker-compose/docker-compose.yml > patches/mlflow/docker-compose/docker-compose.yml.patch`
 - Change **docker-compose .env** with `patch -p1 < patches/mlflow/docker-compose/.env.patch`
    - Update this patch using `diff -u /dev/null mlflow/docker-compose/.env > patches/mlflow/docker-compose/.env.patch`
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
