import base from "@multica/eslint-config/base";

export default [
  ...base,
  { ignores: ["dist/", "release/"] },
  // Security: the renderer decides which URLs reach the OS shell. Every one
  // must go through openExternalSafely in src/main/window-security.ts so the
  // http/https allowlist cannot silently regress.
  {
    files: ["src/main/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='shell'][callee.property.name='openExternal']",
          message:
            "Do not call shell.openExternal directly. Use openExternalSafely from './window-security' so the http/https allowlist stays enforced.",
        },
      ],
    },
  },
  {
    files: ["src/main/window-security.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];
