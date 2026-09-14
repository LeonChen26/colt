/**
 * 设置：provider 与密钥管理
 * 密钥只上行不下行——界面永远拿不到明文，只能看到是否已配置
 */
import { useCallback, useEffect, useState } from "react";
import { Check, KeyRound, Plus, Trash2 } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { ModelOption, ProviderConfig } from "@shared/protocol";
import { cn } from "../lib/utils";

export function Settings(): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setProviders(await window.banyan.invoke("providers.list", undefined));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const notify = useCallback((text: string) => {
    setMessage(text);
    setError(null);
    setTimeout(() => setMessage(null), 2500);
  }, []);

  const fail = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <h2 className="mb-1 text-base">设置</h2>
        <p className="mb-6 text-xs text-text-muted">
          密钥经系统加密后保存在本地，界面不会回显明文。
        </p>

        {message && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-success/40 bg-success-soft px-3 py-2 text-sm text-success-fg">
            <Check {...ICON.md} />
            {message}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm">模型服务</h3>
          <button
            type="button"
            onClick={() => setAdding((value) => !value)}
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-text-secondary transition hover:text-text-primary"
          >
            <Plus {...ICON.sm} />
            添加 OpenAI 兼容服务
          </button>
        </div>

        {adding && (
          <ProviderForm
            onCancel={() => setAdding(false)}
            onSaved={async () => {
              setAdding(false);
              await load();
              notify("已保存");
            }}
            onError={fail}
          />
        )}

        <div className="flex flex-col gap-3">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              onSaved={async (text) => {
                await load();
                notify(text);
              }}
              onError={fail}
            />
          ))}
        </div>

        <ApprovalPolicySettings onSaved={notify} onError={fail} />
      </div>
    </div>
  );
}

/**
 * 审批策略：分析器自动放行的命令白名单。
 * 只在「自动审批模式」下生效——白名单内的命令才允许交给模型分析后自动放行，
 * 其余一律弹窗确认。留空即关闭自动放行。
 */
function ApprovalPolicySettings({
  onSaved,
  onError,
}: {
  onSaved: (message: string) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const { commands } = await window.banyan.invoke("approval.analyzeConfig.get", undefined);
        setText(commands.join("\n"));
      } catch (e) {
        onError(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [onError]);

  const save = async (): Promise<void> => {
    try {
      const commands = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const saved = await window.banyan.invoke("approval.analyzeConfig.set", { commands });
      setText(saved.commands.join("\n"));
      onSaved("审批白名单已保存");
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="mt-6">
      <h3 className="mb-1 text-sm">审批</h3>
      <p className="mb-3 text-xs text-text-muted">
        自动审批模式下，只有首词在此列表中的命令（如 npm / pytest / git）才会交给模型分析后自动放行；
        其余操作一律弹窗确认。留空即关闭自动放行、全部转人工。
      </p>
      <div className="rounded-lg border border-line bg-surface-raised p-3">
        <label className="mb-1 block text-xs text-text-muted">可自动放行的命令（每行一个）</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          disabled={loading}
          placeholder={"npm\npnpm\npytest\ngit"}
          className="w-full resize-none rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs outline-none transition placeholder:text-text-muted focus:border-accent disabled:opacity-50"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => void save()}
            disabled={loading}
            className="rounded-md bg-accent px-3 py-1.5 text-xs text-accent-fg transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  onSaved,
  onError,
}: {
  provider: ProviderConfig;
  onSaved: (message: string) => void | Promise<void>;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const [key, setKey] = useState("");

  const saveKey = async (): Promise<void> => {
    if (!key.trim()) return;
    try {
      if (provider.builtin) {
        await window.banyan.invoke("secrets.set", { key: "deepseek", value: key });
      } else {
        await window.banyan.invoke("providers.save", {
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          models: provider.models,
          apiKey: key,
        });
      }
      setKey("");
      await onSaved("密钥已保存");
    } catch (e) {
      onError(e);
    }
  };

  const remove = async (): Promise<void> => {
    try {
      await window.banyan.invoke("providers.remove", { id: provider.id });
      await onSaved("已删除");
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="rounded-lg border border-line bg-surface-raised p-3">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm">
            {provider.name}
            {provider.builtin && (
              <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-xs text-text-muted">
                内置
              </span>
            )}
            <span
              className={cn(
                "flex items-center gap-1 text-xs",
                provider.hasKey ? "text-success-fg" : "text-warning",
              )}
            >
              <KeyRound {...ICON.xs} />
              {provider.hasKey ? "密钥已配置" : "未配置密钥"}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-xs text-text-muted">
            {provider.baseUrl}
          </div>
        </div>
        {!provider.builtin && (
          <button
            type="button"
            onClick={() => void remove()}
            className="rounded p-1 text-text-muted transition hover:text-danger"
            title="删除"
          >
            <Trash2 {...ICON.md} />
          </button>
        )}
      </div>

      <div className="mb-2 flex flex-wrap gap-1.5">
        {provider.models.map((model) => (
          <span
            key={model.id}
            className="rounded bg-surface-overlay px-2 py-0.5 font-mono text-xs text-text-secondary"
          >
            {model.id}
          </span>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={provider.hasKey ? "输入新密钥以替换" : "粘贴 API Key"}
          className="flex-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs outline-none transition placeholder:text-text-muted focus:border-accent"
        />
        <button
          type="button"
          onClick={() => void saveKey()}
          disabled={!key.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-xs text-accent-fg transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          保存
        </button>
      </div>
    </div>
  );
}

function ProviderForm({
  onCancel,
  onSaved,
  onError,
}: {
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelText, setModelText] = useState("");
  const [apiKey, setApiKey] = useState("");

  const submit = async (): Promise<void> => {
    try {
      // 每行一个模型：id 或 "id|显示名|上下文长度"
      const models: ModelOption[] = modelText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [modelId, label, ctx] = line.split("|").map((part) => part.trim());
          return {
            id: modelId ?? line,
            name: label || (modelId ?? line),
            contextWindow: Number(ctx) > 0 ? Number(ctx) : 128_000,
          };
        });

      if (models.length === 0) throw new Error("至少填写一个模型");

      await window.banyan.invoke("providers.save", {
        id: id.trim(),
        name: name.trim() || id.trim(),
        baseUrl: baseUrl.trim(),
        models,
        apiKey: apiKey.trim() || undefined,
      });
      await onSaved();
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="mb-4 rounded-lg border border-accent/40 bg-surface-raised p-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="标识（英文，唯一）" value={id} onChange={setId} placeholder="my-endpoint" />
        <Field label="显示名" value={name} onChange={setName} placeholder="我的服务" />
      </div>
      <Field
        label="Base URL"
        value={baseUrl}
        onChange={setBaseUrl}
        placeholder="https://api.example.com/v1"
      />
      <div className="mt-2">
        <label className="mb-1 block text-xs text-text-muted">
          模型（每行一个，可写 id|显示名|上下文长度）
        </label>
        <textarea
          value={modelText}
          onChange={(e) => setModelText(e.target.value)}
          rows={3}
          placeholder={"gpt-4o-mini\nqwen-max|通义千问 Max|128000"}
          className="w-full resize-none rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent"
        />
      </div>
      <Field label="API Key" value={apiKey} onChange={setApiKey} type="password" />

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-line px-3 py-1.5 text-xs text-text-secondary"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!id.trim() || !baseUrl.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-xs text-accent-fg disabled:opacity-40"
        >
          保存
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}): React.JSX.Element {
  return (
    <div className="mt-2">
      <label className="mb-1 block text-xs text-text-muted">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs outline-none transition placeholder:text-text-muted focus:border-accent"
      />
    </div>
  );
}
