/**
 * 设置：provider 与密钥管理
 * 密钥只上行不下行——界面永远拿不到明文，只能看到是否已配置
 */
import { useCallback, useEffect, useState } from "react";
import { Brain, Check, Image as ImageIcon, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { ModelOption, ProviderConfig } from "@shared/protocol";
import { DEFAULT_CONTEXT_WINDOW, LEGACY_MAX_TOKENS } from "@shared/model-option";
import { cn } from "../lib/utils";

export function Settings(): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setProviders(await window.colt.invoke("providers.list", undefined));
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
        const { commands } = await window.colt.invoke("approval.analyzeConfig.get", undefined);
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
      const saved = await window.colt.invoke("approval.analyzeConfig.set", { commands });
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
  const [editing, setEditing] = useState(false);

  const saveKey = async (): Promise<void> => {
    if (!key.trim()) return;
    try {
      if (provider.builtin) {
        await window.colt.invoke("secrets.set", { key: "deepseek", value: key });
      } else {
        await window.colt.invoke("providers.save", {
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          models: provider.models,
          // 必须回传，否则这次「只存密钥」会把「无需密钥」的声明重置回「需要密钥」
          requiresKey: provider.requiresKey,
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
      await window.colt.invoke("providers.remove", { id: provider.id });
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
                // 无需密钥是**正常**状态，不该跟「未配置密钥」一样报黄
                !provider.requiresKey
                  ? "text-text-muted"
                  : provider.hasKey
                    ? "text-success-fg"
                    : "text-warning",
              )}
            >
              <KeyRound {...ICON.xs} />
              {!provider.requiresKey
                ? "无需密钥"
                : provider.hasKey
                  ? "密钥已配置"
                  : "未配置密钥"}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-xs text-text-muted">
            {provider.baseUrl}
          </div>
        </div>
        {!provider.builtin && (
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setEditing((value) => !value)}
              className={cn(
                "rounded p-1 transition",
                editing ? "text-accent" : "text-text-muted hover:text-text-primary",
              )}
              title="编辑模型、能力与计价"
            >
              <Pencil {...ICON.md} />
            </button>
            <button
              type="button"
              onClick={() => void remove()}
              className="rounded p-1 text-text-muted transition hover:text-danger"
              title="删除"
            >
              <Trash2 {...ICON.md} />
            </button>
          </div>
        )}
      </div>

      <div className="mb-2 flex flex-wrap gap-1.5">
        {provider.models.map((model) => (
          <span
            key={model.id}
            className="flex items-center gap-1.5 rounded bg-surface-overlay px-2 py-0.5 font-mono text-xs text-text-secondary"
          >
            {model.id}
            {model.imageInput === true && (
              <span title="支持图片输入" className="flex">
                <ImageIcon {...ICON.xs} className="text-text-muted" />
              </span>
            )}
            {model.reasoning === true && (
              <span title="支持推理" className="flex">
                <Brain {...ICON.xs} className="text-text-muted" />
              </span>
            )}
            {(model.price?.input != null || model.price?.output != null) && (
              <span
                className="text-text-muted"
                title="输入/输出价（USD / 百万 tokens）"
              >
                ${model.price?.input ?? 0}/${model.price?.output ?? 0}
              </span>
            )}
          </span>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={
            !provider.requiresKey
              ? "可留空（该服务无需密钥）"
              : provider.hasKey
                ? "输入新密钥以替换"
                : "粘贴 API Key"
          }
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

      {editing && (
        <ProviderForm
          initial={provider}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await onSaved("已保存");
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

/** 表单里一行模型的草稿态：数值用字符串承载，提交时统一解析校验 */
interface ModelDraft {
  id: string;
  name: string;
  contextWindow: string;
  imageInput: boolean;
  reasoning: boolean;
  maxTokens: string;
  priceIn: string;
  priceOut: string;
}

const EMPTY_MODEL_DRAFT: ModelDraft = {
  id: "",
  name: "",
  contextWindow: "",
  imageInput: false,
  reasoning: false,
  maxTokens: "",
  priceIn: "",
  priceOut: "",
};

function modelDraftsFrom(models: ModelOption[]): ModelDraft[] {
  if (models.length === 0) return [{ ...EMPTY_MODEL_DRAFT }];
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: String(model.contextWindow),
    imageInput: model.imageInput === true,
    reasoning: model.reasoning === true,
    maxTokens: model.maxTokens != null ? String(model.maxTokens) : "",
    priceIn: model.price?.input != null ? String(model.price.input) : "",
    priceOut: model.price?.output != null ? String(model.price.output) : "",
  }));
}

function positiveField(text: string, label: string, modelId: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`模型 ${modelId} 的${label}必须是正数`);
  }
  return value;
}

function priceField(text: string, label: string, modelId: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`模型 ${modelId} 的${label}不能是负数或非数字`);
  }
  return value;
}

function ProviderForm({
  initial,
  onCancel,
  onSaved,
  onError,
}: {
  /** 传入即编辑模式：标识（主键）不可改，密钥留空则保持现状 */
  initial?: ProviderConfig;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const editing = initial !== undefined;
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [drafts, setDrafts] = useState<ModelDraft[]>(() =>
    modelDraftsFrom(initial?.models ?? []),
  );
  const [apiKey, setApiKey] = useState("");
  const [requiresKey, setRequiresKey] = useState(initial?.requiresKey ?? true);

  const patchDraft = (index: number, patch: Partial<ModelDraft>): void => {
    setDrafts((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const submit = async (): Promise<void> => {
    try {
      const models: ModelOption[] = drafts.map((draft) => {
        const modelId = draft.id.trim();
        if (!modelId) throw new Error("每个模型都要填写 id");
        const contextWindow =
          positiveField(draft.contextWindow, "上下文长度", modelId) ?? DEFAULT_CONTEXT_WINDOW;
        const maxTokens = positiveField(draft.maxTokens, "最大输出", modelId);
        const priceIn = priceField(draft.priceIn, "输入价", modelId);
        const priceOut = priceField(draft.priceOut, "输出价", modelId);
        const option: ModelOption = {
          id: modelId,
          name: draft.name.trim() || modelId,
          contextWindow,
        };
        if (draft.imageInput) option.imageInput = true;
        if (draft.reasoning) option.reasoning = true;
        if (maxTokens !== undefined) option.maxTokens = maxTokens;
        if (priceIn !== undefined || priceOut !== undefined) {
          const price: NonNullable<ModelOption["price"]> = {};
          if (priceIn !== undefined) price.input = priceIn;
          if (priceOut !== undefined) price.output = priceOut;
          option.price = price;
        }
        return option;
      });

      if (models.length === 0) throw new Error("至少填写一个模型");

      await window.colt.invoke("providers.save", {
        id: id.trim(),
        name: name.trim() || id.trim(),
        baseUrl: baseUrl.trim(),
        models,
        requiresKey,
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
        <Field
          label="标识（英文，唯一）"
          value={id}
          onChange={setId}
          placeholder="my-endpoint"
          disabled={editing}
        />
        <Field label="显示名" value={name} onChange={setName} placeholder="我的服务" />
      </div>
      {editing && (
        <p className="mb-1 text-xs text-text-muted">标识是服务的唯一 key，不可修改。</p>
      )}
      <Field
        label="Base URL"
        value={baseUrl}
        onChange={setBaseUrl}
        placeholder="https://api.example.com/v1"
      />
      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-xs text-text-muted">模型</label>
          <button
            type="button"
            onClick={() => setDrafts((rows) => [...rows, { ...EMPTY_MODEL_DRAFT }])}
            className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs text-text-secondary transition hover:text-text-primary"
          >
            <Plus {...ICON.sm} />
            添加模型
          </button>
        </div>
        <div className="flex flex-col gap-2">
          {drafts.map((draft, index) => (
            <ModelRow
              key={index}
              draft={draft}
              onChange={(patch) => patchDraft(index, patch)}
              onRemove={() => setDrafts((rows) => rows.filter((_, i) => i !== index))}
            />
          ))}
        </div>
        <p className="mt-1.5 text-xs text-text-muted">
          价格为美元 / 百万 tokens，留空按 0 计；最大输出留空按 min(上下文,{" "}
          {LEGACY_MAX_TOKENS})；勾选「图片」后才会放开图片上传，「推理」影响思考输出的处理。
        </p>
      </div>
      <Field
        label="API Key"
        value={apiKey}
        onChange={setApiKey}
        type="password"
        placeholder={editing ? "留空保持现有密钥" : undefined}
      />

      <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={!requiresKey}
          onChange={(e) => setRequiresKey(!e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--color-accent)]"
        />
        <span>
          该服务不需要 API Key（本地 / 自建 endpoint，如 ollama、vLLM、llama.cpp）
          <span className="mt-0.5 block text-text-muted">
            不勾选时，未填密钥的服务会被判定为「还不能用」，默认也不会选中它。
          </span>
        </span>
      </label>

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

const MODEL_INPUT =
  "rounded-md border border-line bg-surface px-2 py-1 font-mono text-xs outline-none transition placeholder:text-text-muted focus:border-accent";

function ModelRow({
  draft,
  onChange,
  onRemove,
}: {
  draft: ModelDraft;
  onChange: (patch: Partial<ModelDraft>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-line bg-surface p-2">
      <div className="grid grid-cols-[1fr_1fr_7rem] gap-2">
        <input
          value={draft.id}
          onChange={(e) => onChange({ id: e.target.value })}
          placeholder="模型 id（必填）"
          className={`${MODEL_INPUT} w-full`}
        />
        <input
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="显示名（可留空）"
          className={`${MODEL_INPUT} w-full`}
        />
        <input
          value={draft.contextWindow}
          onChange={(e) => onChange({ contextWindow: e.target.value })}
          placeholder="上下文"
          inputMode="numeric"
          className={`${MODEL_INPUT} w-full`}
        />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
        <label className="flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap">
          <input
            type="checkbox"
            checked={draft.imageInput}
            onChange={(e) => onChange({ imageInput: e.target.checked })}
            className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent)]"
          />
          图片
        </label>
        <label className="flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap">
          <input
            type="checkbox"
            checked={draft.reasoning}
            onChange={(e) => onChange({ reasoning: e.target.checked })}
            className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent)]"
          />
          推理
        </label>
        <label className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          最大输出
          <input
            value={draft.maxTokens}
            onChange={(e) => onChange({ maxTokens: e.target.value })}
            placeholder={String(LEGACY_MAX_TOKENS)}
            inputMode="numeric"
            className={`${MODEL_INPUT} w-24`}
          />
        </label>
        <label className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          输入价
          <input
            value={draft.priceIn}
            onChange={(e) => onChange({ priceIn: e.target.value })}
            placeholder="0"
            inputMode="decimal"
            className={`${MODEL_INPUT} w-20`}
          />
        </label>
        <label className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          输出价
          <input
            value={draft.priceOut}
            onChange={(e) => onChange({ priceOut: e.target.value })}
            placeholder="0"
            inputMode="decimal"
            className={`${MODEL_INPUT} w-20`}
          />
        </label>
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto rounded p-1 text-text-muted transition hover:text-danger"
          title="移除该模型"
        >
          <Trash2 {...ICON.sm} />
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
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div className="mt-2">
      <label className="mb-1 block text-xs text-text-muted">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs outline-none transition placeholder:text-text-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
      />
    </div>
  );
}
