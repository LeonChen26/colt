/**
 * 会话标题派生规则的钉子。
 *
 * 回归背景（2026-10-11 架构评审 🟡6）：同一条规则原先写在两个进程里——
 * `main/session-manager.ts` 在 view 到达时算一次落库，`renderer/App.tsx` 在 `session.view`
 * 监听里**再算一遍**更新侧栏缓存。两处都是 `firstUser?.text.slice(0, 30)`：
 * 改一处忘另一处 = 界面标题与侧栏标题不一致，**而且不会报错、不会有测试变红**。
 *
 * 所以这里钉两件事：
 *   ① 规则本身（首条 user 消息前 30 字；没有则「不要设标题」）；
 *   ② 两个用家**真的都调它**——各写各的时候，改了一处另一处不会有任何征兆。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SESSION_TITLE_MAX_CHARS, deriveSessionTitle } from "../src/shared/session-title.ts";
import { skillInvocationLabel } from "../src/shared/skill-invocation.ts";
import type { ViewMessage } from "../src/shared/worker-protocol.ts";

function message(role: ViewMessage["role"], text: string): ViewMessage {
  return { id: `m-${role}-${text.length}`, role, text, toolCalls: [] };
}

/** 内核替用户发的技能调用消息：正文是原始标记（`worker/lib/skills.ts` 的 head/tail 定义） */
function skillInvocationMessage(name: string, instructions?: string): ViewMessage {
  return {
    id: `m-skill-${name}`,
    role: "user",
    text: `<skill name="${name}" location="/x/.colt/skills/${name}/SKILL.md">\nReferences are relative to /x/.`,
    toolCalls: [],
    skill: instructions === undefined ? { name } : { name, instructions },
  };
}

describe("deriveSessionTitle：规则本身", () => {
  test("取**首条** user 消息，不是最后一条、也不是最长的", () => {
    const messages = [
      message("user", "第一个问题"),
      message("assistant", "回答"),
      message("user", "追问：这个应该被忽略"),
    ];
    assert.equal(deriveSessionTitle(messages), "第一个问题");
  });

  test("跳过前面的 assistant / other 消息（会话可能以系统消息开头）", () => {
    const messages = [message("other", "压缩摘要"), message("user", "真正的问题")];
    assert.equal(deriveSessionTitle(messages), "真正的问题");
  });

  test(`截断到 ${SESSION_TITLE_MAX_CHARS} 个字符`, () => {
    const long = "字".repeat(SESSION_TITLE_MAX_CHARS + 10);
    const title = deriveSessionTitle([message("user", long)]);
    assert.equal(title, "字".repeat(SESSION_TITLE_MAX_CHARS));
    assert.equal(title?.length, SESSION_TITLE_MAX_CHARS);
  });

  test("刚好等于上限时**不**截断（边界不差一）", () => {
    const exact = "a".repeat(SESSION_TITLE_MAX_CHARS);
    assert.equal(deriveSessionTitle([message("user", exact)]), exact);
  });

  test("没有 user 消息 → undefined（含义是「不要设标题」，不是空标题）", () => {
    assert.equal(deriveSessionTitle([]), undefined);
    assert.equal(deriveSessionTitle([message("assistant", "只有回答")]), undefined);
  });

  test("文本为空 → undefined（两个用家都按「不设标题」处理，故不能用空串占位）", () => {
    assert.equal(deriveSessionTitle([message("user", "")]), undefined);
  });

  test("不改动入参（渲染层与主进程共享同一份 messages 快照）", () => {
    const messages = [message("user", "别动我")];
    const snapshot = JSON.stringify(messages);
    deriveSessionTitle(messages);
    assert.equal(JSON.stringify(messages), snapshot);
  });
});

describe("技能调用：标题要说人话，不能是内核的原始标记", () => {
  test("起手就是一个技能调用时，标题是「技能 <名字>」而不是 `<skill name=...>`", () => {
    const title = deriveSessionTitle([skillInvocationMessage("pdf")]);
    assert.equal(title, "技能 pdf");
    assert.doesNotMatch(title!, /<skill|location=/, "标题里不该出现内核标记");
  });

  test("带额外指示时一并带上（那才是这一轮的意图）", () => {
    assert.equal(
      deriveSessionTitle([skillInvocationMessage("pdf", "只改第 3 节")]),
      "技能 pdf · 只改第 3 节",
    );
  });

  test("与同仓另两处显示（会话目录 / 分支树）用的是同一个 label 函数", () => {
    // 三处显示同一条消息就该是同一行字——这条断言防的是「以后有人给标题另发明一套写法」。
    const label = skillInvocationLabel;
    assert.equal(deriveSessionTitle([skillInvocationMessage("pdf")]), label({ name: "pdf" }));
  });

  test("超过上限仍截断（技能名 + 长指示不会把标题撑爆）", () => {
    const title = deriveSessionTitle([skillInvocationMessage("pdf", "字".repeat(50))]);
    assert.equal(title?.length, SESSION_TITLE_MAX_CHARS);
  });

  test("技能调用在第二条时，标题取的是**第一条普通消息**", () => {
    const title = deriveSessionTitle([
      message("user", "先问个问题"),
      skillInvocationMessage("pdf", "再看这个"),
    ]);
    assert.equal(title, "先问个问题");
  });
});

/**
 * 去掉注释后的源码。
 *
 * 负向断言（「不该再内联 `slice(0, 30)`」）必须只看**代码**：注释里为了说明历史而提到
 * 旧写法是正常的，甚至是应该的——我第一版直接扫全文，结果被自己写的说明注释判红（假阳性）。
 * 反向的代价也要知道：字符串字面量里若出现该写法会被一并去掉（本用例不涉及），
 * 所以这个粗暴的剥离只用在**负向**断言上。
 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("两个用家共用同一份规则（这是本模块存在的全部理由）", () => {
  const readers = [
    { label: "主进程（落库）", path: "src/main/session-manager.ts" },
    { label: "渲染层（侧栏缓存）", path: "src/renderer/src/App.tsx" },
  ];

  for (const { label, path } of readers) {
    test(`${label} 调用 deriveSessionTitle，且不再内联 slice(0, 30)`, () => {
      const text = codeOnly(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
      assert.match(
        text,
        /deriveSessionTitle/,
        `${label} 没有使用共享的标题派生——两处各写一遍就是漂开的开始`,
      );
      // 内联的 `slice(0, 30)` 正是旧实现：留着它说明有人又把规则抄回去了
      assert.doesNotMatch(
        text,
        /\.text\.slice\(0,\s*30\)/,
        `${label} 又内联了旧的 slice(0, 30) 写法；请改用 @shared/session-title`,
      );
    });
  }

  test("上限常量只有一个来源（不许在被调方再出现 30 这个魔数）", () => {
    const source = readFileSync(new URL("../src/shared/session-title.ts", import.meta.url), "utf8");
    assert.match(source, /SESSION_TITLE_MAX_CHARS\s*=\s*30/);
    // 调用方只该引用常量名，不该出现字面量 30 做截断
    for (const path of ["src/main/session-manager.ts", "src/renderer/src/App.tsx"]) {
      const text = codeOnly(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
      assert.doesNotMatch(text, /slice\(0,\s*SESSION_TITLE_MAX_CHARS\s*\)|slice\(0,\s*30\)/);
    }
  });
});
