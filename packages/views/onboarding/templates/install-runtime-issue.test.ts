// @vitest-environment node
import { describe, expect, it } from "vitest";
import { INSTALL_RUNTIME_ISSUE_BODY } from "./install-runtime-issue";

describe("runtime onboarding deployment copy", () => {
  it("checks the bundled Mac worker before configuring another device", () => {
    expect(INSTALL_RUNTIME_ISSUE_BODY.zh).toContain("单人 Mac 发行包已经包含本实例的 CLI 和 worker");
    expect(INSTALL_RUNTIME_ISSUE_BODY.zh).toContain("本机或获准的远程设备");
    expect(INSTALL_RUNTIME_ISSUE_BODY.en).toContain("Check their status before installing anything again");
    expect(INSTALL_RUNTIME_ISSUE_BODY.en).toContain("local or remote");
  });

  it("retains manual project management and user authorization while a runtime is unavailable", () => {
    for (const body of Object.values(INSTALL_RUNTIME_ISSUE_BODY)) {
      expect(body).toContain("backlog");
      expect(body).toContain("BayClaw Helper");
      expect(body).toContain("CLI");
      expect(body).toContain("worker");
      expect(body).not.toMatch(/shared cloud runtimes|nothing to download or install|共享云端服务器|ä»»|ã/);
    }
    expect(INSTALL_RUNTIME_ISSUE_BODY.zh).toContain("模型和工具仍需本实例用户自己的授权");
  });
});
