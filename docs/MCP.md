# 接入 MCP server

MCP（Model Context Protocol）server 的工具会以**普通内核工具**的身份进入，天然过 `before_tool` 审批闸门——不是给 agent 开的旁路。

配置是 JSON，放两处之一（**项目级同名覆盖用户级**）：

- 项目级 `<项目根>/.colt/mcp.json`——只对当前项目生效；
- 用户级 `~/.colt/mcp.json`——对全部项目生效（常见 server 只配一次）。

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" }
    }
  }
}
```

- 本地进程用 `command`（+ `args` / `env`），远程用 `url`（+ `headers` / `transport`，缺省 Streamable HTTP，可写 `"sse"`）——**二选一**。
- 字符串值支持 `${VAR}` 展开成进程环境变量；**缺变量会成告警并跳过该 server，而不是静默留空**。密钥一律用 `${VAR}`，别写明文。
- stdio 子进程的工作目录就是**项目根**——`args` 里的相对路径（如 `"."`）按它解析。
- 改完在**设置页**点「重新加载」即生效、**不必重启会话**；设置页同时显示每台 server 的连接状态、工具清单与配置诊断。

**不想手写配置？** 直接让 agent 做：「帮我接一个 X 的 MCP server」。它知道格式与两个位置，会创建文件、告诉你装上了什么工具，并提示点一下重载；写用户级（项目外的 `~/.colt/`）时会先征得你同意。

---

设计取舍（为什么是「普通内核工具」而不是旁路、传输与超时怎么定的、掉线怎么告知）见 `docs/DESIGN-mcp.md`；安全边界见 `docs/SECURITY.md`。
