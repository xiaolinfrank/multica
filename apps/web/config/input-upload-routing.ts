// A dynamic Route Handler owns raw input bytes. The generic API rewrite must
// leave that exact destination to the app router, including in development.
export const INPUT_AWARE_API_REWRITE = "/api/:path((?!cockpit/inputs/[^/]+/versions/[^/]+/transfers/[^/]+/bytes/?$).*)";
