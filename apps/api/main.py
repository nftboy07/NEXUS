"""NEXUS API — FastAPI skeleton (Phase 1). Read-only monitoring."""
from fastapi import FastAPI

app = FastAPI(title="NEXUS", description="Autonomous Blockchain Intelligence Network")

@app.get("/health")
def health():
    return {"status": "ok", "service": "nexus-api"}

@app.get("/chains")
def chains():
    return [{"id": 1, "name": "ethereum"}, {"id": 8453, "name": "base"}]

# TODO Phase 3+: watchlists, wallet profiles, alerts, investigations endpoints.
