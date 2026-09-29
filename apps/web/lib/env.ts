// Environment configuration, validated once at module load. Documented in
// .env.example.

const basemapUrl = process.env.NEXT_PUBLIC_BASEMAP_URL
if (!basemapUrl) {
  throw new Error("NEXT_PUBLIC_BASEMAP_URL is not defined in the environment variables file: .env.local")
}

// Basemap for the dark theme; the light theme uses NEXT_PUBLIC_BASEMAP_URL.
const basemapDarkUrl = process.env.NEXT_PUBLIC_BASEMAP_DARK_URL
if (!basemapDarkUrl) {
  throw new Error("NEXT_PUBLIC_BASEMAP_DARK_URL is not defined in the environment variables file: .env.local")
}

// FastAPI agent backend (apps/api): conversations, the chat stream, the
// query form, place search and quicklooks. A full URL in development
// (http://localhost:8787); "/api" in the Docker image, where the API serves
// the app beside itself on one origin.
const agentApiUrl = process.env.NEXT_PUBLIC_AGENT_API_URL
if (!agentApiUrl) {
  throw new Error("NEXT_PUBLIC_AGENT_API_URL is not defined in the environment variables file: .env.local")
}

export const env = { basemapUrl, basemapDarkUrl, agentApiUrl } as const
