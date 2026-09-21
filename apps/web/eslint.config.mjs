import nextConfig from "@multica/eslint-config/next";

export default [
  ...nextConfig,
  // ".next.prev-*" / ".next.new" are the staged and rollback copies a deploy
  // leaves beside the live build (see bayclaw-serve.sh); they are build output
  // that happens not to be named ".next".
  { ignores: [".next*/", ".source*/"] },
  {
    files: ["**/*.test.{ts,tsx}", "**/test/**/*.{ts,tsx}"],
    rules: {
      "react/display-name": "off",
    },
  },
];
