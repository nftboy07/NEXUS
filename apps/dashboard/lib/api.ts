// Server-side fetch helper. The API key lives only in server env —
// client components call the /api/nexus proxy route instead.

const base = () => process.env.NEXUS_API_URL ?? "http://localhost:8000";

export async function apiGet(path: string): Promise<Response> {
  return fetch(`${base()}${path}`, {
    headers: { "X-Api-Key": process.env.NEXUS_API_KEY ?? "" },
    cache: "no-store",
  });
}

export async function apiJson<T>(path: string): Promise<T | null> {
  const res = await apiGet(path);
  if (!res.ok) return null;
  return res.json() as Promise<T>;
}
