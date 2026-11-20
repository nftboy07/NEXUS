# Build context: repo root (main.py reads packages/chain_config/chains.json).
FROM python:3.12-slim
WORKDIR /repo/apps/api
COPY apps/api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY packages/chain_config /repo/packages/chain_config
COPY apps/api/ .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
