import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export", // Static export for Azure Static Web Apps
  images: { unoptimized: true },
};

export default nextConfig;
