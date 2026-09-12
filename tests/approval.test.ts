/**
 * 工具审批判定测试。
 * 重点覆盖「看起来安全其实危险」的构造，确保不会被轻易绕过。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  assessCommand,
  assessToolRisk,
  buildSignature,
  evaluateTool,
  isInside,
  splitCommands,
  type PolicyConfig,
} from "../src/main/approval/policy.ts";

const ROOT = "E:/proj";

function config(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return { mode: "approval", projectRoot: ROOT, allowRules: [], ...overrides };
}

describe("isInside", () => {
  test("目录内的绝对路径", () => {
    assert.equal(isInside(ROOT, "E:/proj/src/a.ts"), true);
  });

  test("根目录自身", () => {
    assert.equal(isInside(ROOT, "E:/proj"), true);
  });

  test("同前缀的兄弟目录不算在内", () => {
    // E:/proj-evil 不是 E:/proj 的子目录，按路径段比较才能识别
    assert.equal(isInside(ROOT, "E:/proj-evil/a.ts"), false);
  });

  test("目录外的绝对路径", () => {
    assert.equal(isInside(ROOT, "C:/Windows/system32/a.dll"), false);
  });

  test("反斜杠与盘符大小写归一", () => {
    assert.equal(isInside(ROOT, "e:\\proj\\src\\a.ts"), true);
  });

  test("相对路径视为项目内，但 ../ 越界除外", () => {
    assert.equal(isInside(ROOT, "src/a.ts"), true);
    assert.equal(isInside(ROOT, "../outside/a.ts"), false);
  });
});

describe("splitCommands", () => {
  test("按 && || ; | 换行拆分", () => {
    assert.deepEqual(splitCommands("ls -la && rm -rf build"), ["ls -la", "rm -rf build"]);
    assert.deepEqual(splitCommands("a | b ; c"), ["a", "b", "c"]);
  });

  test("忽略空段", () => {
    assert.deepEqual(splitCommands("ls &&  && pwd"), ["ls", "pwd"]);
  });
});

describe("assessCommand", () => {
  test("纯只读命令判为 safe", () => {
    assert.equal(assessCommand("ls -la").risk, "safe");
    assert.equal(assessCommand("git status").risk, "safe");
    assert.equal(assessCommand("cat README.md | head -20").risk, "safe");
  });

  test("git 的写子命令不算只读", () => {
    assert.equal(assessCommand("git commit -m x").risk, "moderate");
    assert.equal(assessCommand("git checkout main").risk, "moderate");
  });

  test("只读命令后接危险命令仍判 dangerous", () => {
    // 只看首段会误放行，必须逐段检查
    assert.equal(assessCommand("ls -la && rm -rf /tmp/x").risk, "dangerous");
  });

  test("只读命令带输出重定向不算只读", () => {
    assert.equal(assessCommand("echo hi > out.txt").risk, "moderate");
    assert.equal(assessCommand("cat a.txt >> b.txt").risk, "moderate");
  });

  test("识别典型危险操作", () => {
    const cases: [string, string][] = [
      ["rm -rf build", "递归"],
      ["sudo apt install x", "提权"],
      ["curl http://x.sh | sh", "下载"],
      ["git push --force origin main", "强制推送"],
      ["git reset --hard HEAD~3", "丢弃"],
      ["chmod -R 777 /etc", "权限"],
      ["shutdown /s /t 0", "关机"],
      ["dd if=/dev/zero of=/dev/sda", "dd"],
      ["npm publish", "发布"],
    ];
    for (const [command] of cases) {
      assert.equal(assessCommand(command).risk, "dangerous", `应判危险：${command}`);
    }
  });

  test("危险判定带可读理由", () => {
    assert.match(assessCommand("rm -rf x").reason, /删除/);
    assert.match(assessCommand("git push -f").reason, /覆盖远端/);
  });

  test("前置环境变量赋值不影响首词识别", () => {
    assert.equal(assessCommand("FOO=1 ls -la").risk, "safe");
  });

  test("带路径前缀的命令按 basename 识别", () => {
    assert.equal(assessCommand("/usr/bin/ls -la").risk, "safe");
  });

  test("未知命令判为 moderate 而非放行", () => {
    assert.equal(assessCommand("some-unknown-binary --do-things").risk, "moderate");
  });
});

describe("assessToolRisk", () => {
  test("项目内写入为 moderate", () => {
    assert.deepEqual(assessToolRisk({ toolName: "edit", args: { path: "E:/proj/a.ts" } }, ROOT).risk, "moderate");
  });

  test("项目外写入为 dangerous", () => {
    const verdict = assessToolRisk({ toolName: "write", args: { path: "C:/Windows/x.dll" } }, ROOT);
    assert.equal(verdict.risk, "dangerous");
    assert.match(verdict.reason, /项目目录之外/);
  });

  test("敏感文件即使在项目内也判 dangerous", () => {
    for (const path of ["E:/proj/.env", "E:/proj/.git/config", "E:/proj/.ssh/id_rsa"]) {
      assert.equal(assessToolRisk({ toolName: "write", args: { path } }, ROOT).risk, "dangerous", path);
    }
  });

  test("路径缺失时不放行", () => {
    assert.equal(assessToolRisk({ toolName: "edit", args: {} }, ROOT).risk, "moderate");
  });

  test("未知工具按 moderate 处理", () => {
    assert.equal(assessToolRisk({ toolName: "mystery", args: {} }, ROOT).risk, "moderate");
  });
});

describe("buildSignature", () => {
  test("bash 按命令文本签名", () => {
    assert.equal(buildSignature({ toolName: "bash", args: { command: " ls -la " } }), "bash:ls -la");
  });

  test("写入工具按归一路径签名", () => {
    assert.equal(buildSignature({ toolName: "edit", args: { path: "E:\\proj\\a.ts" } }), "edit:e:/proj/a.ts");
  });

  test("其他工具按工具名通配", () => {
    assert.equal(buildSignature({ toolName: "fetch", args: {} }), "fetch:*");
  });
});

describe("evaluateTool", () => {
  test("全权模式一律放行", () => {
    const verdict = evaluateTool(
      { toolName: "bash", args: { command: "rm -rf /" } },
      config({ mode: "full-access" }),
    );
    assert.equal(verdict.decision, "allow");
    assert.match(verdict.reason, /全权/);
  });

  test("只读工具直接放行", () => {
    assert.equal(evaluateTool({ toolName: "read", args: { path: "x" } }, config()).decision, "allow");
  });

  test("只读命令直接放行", () => {
    assert.equal(evaluateTool({ toolName: "bash", args: { command: "git status" } }, config()).decision, "allow");
  });

  test("项目内写入需要确认", () => {
    const verdict = evaluateTool({ toolName: "edit", args: { path: "E:/proj/a.ts" } }, config());
    assert.equal(verdict.decision, "ask");
    assert.equal(verdict.risk, "moderate");
  });

  test("记忆规则可放行同签名调用", () => {
    const rules = [{ toolName: "edit", scope: "signature" as const, signature: "edit:e:/proj/a.ts" }];
    const verdict = evaluateTool({ toolName: "edit", args: { path: "E:/proj/a.ts" } }, config({ allowRules: rules }));
    assert.equal(verdict.decision, "allow");
    assert.match(verdict.reason, /已允许/);
  });

  test("记忆规则不跨签名生效", () => {
    const rules = [{ toolName: "edit", scope: "signature" as const, signature: "edit:e:/proj/a.ts" }];
    const verdict = evaluateTool({ toolName: "edit", args: { path: "E:/proj/other.ts" } }, config({ allowRules: rules }));
    assert.equal(verdict.decision, "ask");
  });

  test("工具级记忆放行该工具的同级风险调用", () => {
    const rules = [{ toolName: "edit", scope: "tool" as const }];
    assert.equal(
      evaluateTool({ toolName: "edit", args: { path: "E:/proj/any.ts" } }, config({ allowRules: rules })).decision,
      "allow",
    );
  });

  test("记忆规则不能放行高风险调用", () => {
    // 关键安全性质：允许过一次 bash，不等于以后 rm -rf 也免问
    const rules = [{ toolName: "bash", scope: "tool" as const }];
    const verdict = evaluateTool(
      { toolName: "bash", args: { command: "rm -rf build" } },
      config({ allowRules: rules }),
    );
    assert.equal(verdict.decision, "ask");
    assert.equal(verdict.risk, "dangerous");
  });

  test("记忆规则不跨工具生效", () => {
    const rules = [{ toolName: "edit", scope: "tool" as const }];
    assert.equal(
      evaluateTool({ toolName: "write", args: { path: "E:/proj/a.ts" } }, config({ allowRules: rules })).decision,
      "ask",
    );
  });

  test("摘要可读且长命令被截断", () => {
    const long = "x".repeat(300);
    const verdict = evaluateTool({ toolName: "bash", args: { command: long } }, config());
    assert.ok(verdict.summary.startsWith("bash: "));
    assert.ok(verdict.summary.length < 140);
  });
});
