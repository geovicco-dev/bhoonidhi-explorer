import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Exported as static files (out/); in the Docker image the API serves them
  // beside itself. The app has one page and no server-side features. See
  // README.md.
  output: "export",
  transpilePackages: ["@workspace/ui"],
  // The dev-mode route badge sits under the map attribution; build and runtime
  // errors still show without it.
  devIndicators: false,
}

export default nextConfig
