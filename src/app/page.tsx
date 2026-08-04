"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Link from "next/link";
import {
  Activity,
  AlertCircle,
  Bot,
  CheckCircle2,
  Copy,
  Download,
  FileSpreadsheet,
  History,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings2,
  TestTube2,
  Trash2,
  UploadCloud,
  Wand2,
  X
} from "lucide-react";
import { ORDER_FIELD_LABELS, ORDER_FIELDS } from "@/lib/fields";
import { makeId } from "@/lib/ids";
import { validateRows } from "@/lib/validation";
import type {
  IntermediateDocument,
  LlmProfile,
  LlmProfileView,
  LlmProtocol,
  OrderField,
  OrderGroup,
  ParsedOrderRow,
  ParseResult,
  ParsingRule,
  ValidationIssue
} from "@/types";

type Toast = { kind: "success" | "error" | "info"; text: string };
type HistoryState = { items: OrderGroup[]; total: number };
type HistoryFilters = { query: string; from: string; to: string; page: number; pageSize: number };
type RulePreviewState = { rows: ParsedOrderRow[]; issues: ValidationIssue[]; elapsedMs?: number };
type ImportErrorState = { title: string; message: string; fileName?: string; fileSize?: number; fileType?: string };
type ProfileRequiredField = "name" | "baseUrl" | "apiKey" | "model";
type ProfileFieldErrors = Partial<Record<ProfileRequiredField, string>>;
type PreviewColumnKey = "rowIndex" | OrderField | "action";
type PreviewColumnWidths = Record<PreviewColumnKey, number>;
type HealthState = {
  ok: boolean;
  storage: "database" | "local-json";
  llmConfigured: boolean;
  defaultRuleCount: number;
};
type LlmProfileDraft = Omit<LlmProfile, "createdAt" | "updatedAt"> & {
  createdAt?: string;
  updatedAt?: string;
  hasApiKey?: boolean;
  source?: LlmProfileView["source"];
};

const DEFAULT_LLM_PROMPT = `你是物流批量下单系统的解析规则架构师。请根据上传文件的结构样本生成一份解析规则 JSON。
要求：
1. 只生成解析规则，不直接输出订单数据。
2. 不依赖文件名判断业务含义。
3. 必须标注 assumptions，说明哪些字段映射是推测的。
4. 输出必须是合法 JSON，字段结构符合 ParsingRule。
5. 字段名只能使用 externalCode, storeName, recipientName, recipientPhone, recipientAddress, skuCode, skuName, skuQuantity, skuSpec, remark。
6. description/name/assumptions 字符串内部不要使用英文双引号，避免破坏 JSON。
7. cards/textBlocks/multiSection 的 itemLinePattern 只匹配真实 SKU 明细行，不能匹配表头、合计、收货信息或区块标题。`;

const editableFields = ORDER_FIELDS;
const protocolOptions: { value: LlmProtocol; label: string; baseUrl: string; model: string }[] = [
  { value: "openai-compatible", label: "OpenAI 兼容 / Chat Completions", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  { value: "minimax-native", label: "MiniMax 原生 / chatcompletion_v2", baseUrl: "https://api.minimaxi.com/v1/text/chatcompletion_v2", model: "MiniMax-M3" },
  { value: "anthropic-compatible", label: "Anthropic 兼容 / Messages", baseUrl: "https://api.minimaxi.com/anthropic", model: "MiniMax-M3" }
];
const MINIMAX_OPENAI_BASE_URL = "https://api.minimaxi.com/v1";
const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
const MINIMAX_NATIVE_BASE_URL = "https://api.minimaxi.com/v1/text/chatcompletion_v2";
const profileRequiredFields: ProfileRequiredField[] = ["name", "baseUrl", "apiKey", "model"];
const DEFAULT_PREVIEW_COLUMN_WIDTHS: PreviewColumnWidths = {
  rowIndex: 54,
  externalCode: 140,
  storeName: 180,
  recipientName: 132,
  recipientPhone: 150,
  recipientAddress: 360,
  skuCode: 132,
  skuName: 160,
  skuQuantity: 116,
  skuSpec: 132,
  remark: 180,
  action: 60
};

function nowIso() {
  return new Date().toISOString();
}

function createBlankRule(): ParsingRule {
  const now = nowIso();
  return {
    id: makeId("rule"),
    name: "新建导入模板",
    description: "手工配置的万能导入解析规则",
    sourceKind: "any",
    layout: "tabular",
    sheetMode: "first",
    headerRowIndex: 0,
    dataStartRowIndex: 1,
    groupBy: "externalCode",
    mappings: [],
    generationPrompt: DEFAULT_LLM_PROMPT,
    createdAt: now,
    updatedAt: now
  };
}

function createBlankProfile(): LlmProfileDraft {
  const now = nowIso();
  return {
    id: makeId("llm"),
    name: "新建模型 Profile",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    apiKey: "",
    temperature: 0.1,
    timeoutMs: 25000,
    enabled: true,
    createdAt: now,
    updatedAt: now
  };
}

function draftFromProfile(profile: LlmProfileView): LlmProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol || "openai-compatible",
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: "",
    temperature: profile.temperature ?? 0.1,
    timeoutMs: profile.timeoutMs ?? 25000,
    enabled: profile.enabled ?? true,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    hasApiKey: profile.hasApiKey,
    source: profile.source
  };
}

function isIssueFor(issues: ValidationIssue[], rowId: string, field: OrderField) {
  return issues.some((issue) => issue.rowId === rowId && issue.field === field && issue.severity === "error");
}

function formatMs(ms?: number) {
  if (ms === undefined) return "-";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function parseRuleDraft(ruleDraft: string) {
  try {
    return JSON.parse(ruleDraft) as ParsingRule;
  } catch {
    return null;
  }
}

function stringifyRuleDraft(rule: Partial<ParsingRule>) {
  const { builtIn: _builtIn, generationPrompt: _generationPrompt, ...visibleRule } = rule;
  return JSON.stringify(visibleRule, null, 2);
}

function normalizeProfileDraft(profile: LlmProfileDraft): LlmProfileDraft {
  const name = profile.name.trim();
  const baseUrl = profile.baseUrl.trim().replace(/\/$/, "");
  const model = profile.model.trim();
  const apiKey = profile.apiKey.trim();
  const isMiniMaxModel = /minimax/i.test(model) || /minimax/i.test(name);
  const looksAnthropic = baseUrl.includes("/anthropic") || baseUrl.endsWith("/messages") || baseUrl.includes("/v1/messages");
  const looksMiniMaxNative = baseUrl.includes("chatcompletion_v2");
  const looksOpenAi = baseUrl.endsWith("/chat/completions") || baseUrl.includes("/v1/chat/completions");
  const protocol =
    isMiniMaxModel && profile.protocol === "openai-compatible" && looksAnthropic
      ? "minimax-native"
      : looksMiniMaxNative
        ? "minimax-native"
        : looksAnthropic
          ? "anthropic-compatible"
          : looksOpenAi
            ? "openai-compatible"
            : profile.protocol;
  let nextBaseUrl = baseUrl;

  if (isMiniMaxModel) {
    nextBaseUrl = protocol === "anthropic-compatible" ? MINIMAX_ANTHROPIC_BASE_URL : protocol === "minimax-native" ? MINIMAX_NATIVE_BASE_URL : MINIMAX_OPENAI_BASE_URL;
  }

  return { ...profile, name, protocol, baseUrl: nextBaseUrl, model, apiKey };
}

function validateProfileDraft(profile: LlmProfileDraft, canReuseSavedKey: boolean) {
  const errors: ProfileFieldErrors = {};

  if (!profile.name.trim()) errors.name = "请输入 Profile 名称。";
  if (!profile.baseUrl.trim()) {
    errors.baseUrl = "请输入 API URL。";
  } else {
    try {
      const parsedUrl = new URL(profile.baseUrl.trim());
      if (!["http:", "https:"].includes(parsedUrl.protocol)) errors.baseUrl = "API URL 需要以 http:// 或 https:// 开头。";
    } catch {
      errors.baseUrl = "请输入合法的 API URL。";
    }
  }
  if (!profile.model.trim()) errors.model = "请输入模型名称。";
  if (!canReuseSavedKey && !profile.apiKey.trim()) errors.apiKey = "请输入 API Key。";

  return errors;
}

function firstProfileErrorMessage(errors: ProfileFieldErrors) {
  const firstKey = profileRequiredFields.find((field) => errors[field]);
  return firstKey ? errors[firstKey] || "请补充模型 Profile 的必填项。" : "请补充模型 Profile 的必填项。";
}

function isProfileRequiredField(key: keyof LlmProfileDraft): key is ProfileRequiredField {
  return profileRequiredFields.includes(key as ProfileRequiredField);
}

function protocolLabel(protocol: LlmProtocol) {
  if (protocol === "anthropic-compatible") return "Anthropic";
  if (protocol === "minimax-native") return "MiniMax 原生";
  return "OpenAI";
}

function profileProtocolBadge(protocol: LlmProtocol) {
  if (protocol === "anthropic-compatible") return "Anthropic Messages";
  if (protocol === "minimax-native") return "MiniMax chatcompletion_v2";
  return "OpenAI Chat";
}

export default function Home() {
  const [rules, setRules] = useState<ParsingRule[]>([]);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [ruleDraft, setRuleDraft] = useState(() => stringifyRuleDraft(createBlankRule()));
  const [llmProfiles, setLlmProfiles] = useState<LlmProfileView[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileDraft, setProfileDraft] = useState<LlmProfileDraft>(() => createBlankProfile());
  const [profileFieldErrors, setProfileFieldErrors] = useState<ProfileFieldErrors>({});
  const [profileSaving, setProfileSaving] = useState(false);
  const [testMessage, setTestMessage] = useState("");
  const [testState, setTestState] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [modelConfigOpen, setModelConfigOpen] = useState(false);
  const [ruleConfigOpen, setRuleConfigOpen] = useState(false);
  const [aiPromptDraft, setAiPromptDraft] = useState(DEFAULT_LLM_PROMPT);
  const [rulePreview, setRulePreview] = useState<RulePreviewState | null>(null);
  const [ruleActionNotice, setRuleActionNotice] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [documentInfo, setDocumentInfo] = useState<IntermediateDocument | null>(null);
  const [rows, setRows] = useState<ParsedOrderRow[]>([]);
  const [previewPage, setPreviewPage] = useState(1);
  const [previewPageSize, setPreviewPageSize] = useState(50);
  const [previewColumnWidths, setPreviewColumnWidths] = useState<PreviewColumnWidths>(DEFAULT_PREVIEW_COLUMN_WIDTHS);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [history, setHistory] = useState<HistoryState>({ items: [], total: 0 });
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>({ query: "", from: "", to: "", page: 1, pageSize: 20 });
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [lastError, setLastError] = useState<ImportErrorState | null>(null);
  const [aiProvider, setAiProvider] = useState<"llm" | "fallback" | null>(null);
  const [progressDetail, setProgressDetail] = useState("");
  const [health, setHealth] = useState<HealthState | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyDetailOpen, setHistoryDetailOpen] = useState(false);
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const parentRef = useRef<HTMLDivElement>(null);

  const selectedRule = useMemo(() => rules.find((rule) => rule.id === selectedRuleId), [rules, selectedRuleId]);
  const selectedProfile = useMemo(() => llmProfiles.find((profile) => profile.id === selectedProfileId), [llmProfiles, selectedProfileId]);
  const ruleSummary = useMemo(() => parseRuleDraft(ruleDraft), [ruleDraft]);
  const selectedRuleIsBuiltIn = Boolean(selectedRule?.builtIn);
  const hasExecutableRule = Boolean(ruleSummary?.mappings?.length);
  const clientIssues = useMemo(() => validateRows(rows), [rows]);
  const persistentServerIssues = serverIssues.filter((issue) => issue.id.includes("external_duplicate_existing"));
  const issues = rows.length ? [...clientIssues, ...persistentServerIssues] : serverIssues;
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const groupsCount = useMemo(() => new Set(rows.map((row) => row.externalCode || row.id)).size, [rows]);
  const historyTotalPages = Math.max(1, Math.ceil(history.total / historyFilters.pageSize));
  const historyStart = history.total ? (historyFilters.page - 1) * historyFilters.pageSize + 1 : 0;
  const historyEnd = Math.min(history.total, historyFilters.page * historyFilters.pageSize);
  const canUseSavedKey = Boolean(profileDraft.hasApiKey || profileDraft.id === "env-default");
  const selectedProfileUsable = Boolean(selectedProfile && selectedProfile.enabled !== false && selectedProfile.hasApiKey);
  const isGeneratingRule = busy === "AI 正在分析文件并生成规则";
  const isRulePreParsing = busy === "正在预解析当前文件";
  const previewTotalPages = Math.max(1, Math.ceil(rows.length / previewPageSize));
  const editingExistingProfile = llmProfiles.some((profile) => profile.id === profileDraft.id);
  const isTestingProfile = testState === "testing" && !profileSaving;
  const previewStart = rows.length ? (previewPage - 1) * previewPageSize + 1 : 0;
  const previewEnd = Math.min(rows.length, previewPage * previewPageSize);
  const previewGridTemplate = useMemo(
    () => [
      previewColumnWidths.rowIndex,
      ...editableFields.map((field) => previewColumnWidths[field]),
      previewColumnWidths.action
    ].map((width) => `${width}px`).join(" "),
    [previewColumnWidths]
  );
  const previewTableWidth = useMemo(
    () => previewColumnWidths.rowIndex + editableFields.reduce((sum, field) => sum + previewColumnWidths[field], 0) + previewColumnWidths.action,
    [previewColumnWidths]
  );
  const selectedHistoryOrder = useMemo(
    () => history.items.find((order) => order.id === selectedHistoryId) || history.items[0],
    [history.items, selectedHistoryId]
  );
  const pagedRows = useMemo(
    () => rows.slice((previewPage - 1) * previewPageSize, previewPage * previewPageSize),
    [previewPage, previewPageSize, rows]
  );

  const virtualizer = useVirtualizer({
    count: pagedRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 42,
    overscan: 12
  });

  const showToast = useCallback((kind: Toast["kind"], text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const loadRules = useCallback(async () => {
    const response = await fetch("/api/rules", { cache: "no-store" });
    const data = await response.json();
    setRules(data.rules || []);
    setRulesLoaded(true);
  }, []);

  const loadProfiles = useCallback(async () => {
    const response = await fetch("/api/llm-profiles", { cache: "no-store" });
    const data = await response.json();
    const profiles = (data.profiles || []) as LlmProfileView[];
    setLlmProfiles(profiles);
    setProfilesLoaded(true);
  }, []);

  const loadHistory = useCallback(async () => {
    const params = new URLSearchParams({
      query: historyFilters.query,
      from: historyFilters.from,
      to: historyFilters.to,
      page: String(historyFilters.page),
      pageSize: String(historyFilters.pageSize)
    });
    const response = await fetch(`/api/orders?${params.toString()}`, { cache: "no-store" });
    const data = await response.json();
    setHistory({ items: data.items || [], total: data.total || 0 });
  }, [historyFilters]);

  const openLatestHistory = useCallback(async () => {
    const nextFilters = { query: "", from: "", to: "", page: 1, pageSize: historyFilters.pageSize };
    setHistoryOpen(true);
    setHistoryFilters(nextFilters);
    const params = new URLSearchParams({
      query: nextFilters.query,
      from: nextFilters.from,
      to: nextFilters.to,
      page: String(nextFilters.page),
      pageSize: String(nextFilters.pageSize)
    });
    const response = await fetch(`/api/orders?${params.toString()}`, { cache: "no-store" });
    const data = await response.json();
    setHistory({ items: data.items || [], total: data.total || 0 });
    setHistoryOpen(true);
  }, [historyFilters.pageSize]);

  async function resetHistoryFilters() {
    const nextFilters = { query: "", from: "", to: "", page: 1, pageSize: historyFilters.pageSize };
    setHistoryFilters(nextFilters);
    const params = new URLSearchParams({
      query: nextFilters.query,
      from: nextFilters.from,
      to: nextFilters.to,
      page: String(nextFilters.page),
      pageSize: String(nextFilters.pageSize)
    });
    const response = await fetch(`/api/orders?${params.toString()}`, { cache: "no-store" });
    const data = await response.json();
    setHistory({ items: data.items || [], total: data.total || 0 });
  }

  const loadHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const data = (await response.json()) as HealthState;
      setHealth(response.ok && data.ok ? data : null);
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    loadRules();
    loadProfiles();
    loadHistory();
    loadHealth();
  }, [loadRules, loadProfiles, loadHistory, loadHealth]);

  useEffect(() => {
    if (selectedRule) {
      setRuleDraft(stringifyRuleDraft(selectedRule));
      setAiPromptDraft(selectedRule.generationPrompt || DEFAULT_LLM_PROMPT);
    }
  }, [selectedRule]);

  useEffect(() => {
    if (previewPage > previewTotalPages) setPreviewPage(previewTotalPages);
  }, [previewPage, previewTotalPages]);

  useEffect(() => {
    if (!history.items.length) {
      setSelectedHistoryId("");
      return;
    }
    if (!history.items.some((order) => order.id === selectedHistoryId)) {
      setSelectedHistoryId(history.items[0].id);
    }
  }, [history.items, selectedHistoryId]);

  async function runWithProgress<T>(label: string, task: () => Promise<T>) {
    setBusy(label);
    setProgress(8);
    setProgressDetail("准备处理 0/1");
    const timer = window.setInterval(() => setProgress((value) => Math.min(92, value + Math.random() * 14)), 220);
    try {
      const result = await task();
      setProgress(100);
      return result;
    } finally {
      window.clearInterval(timer);
      window.setTimeout(() => {
        setBusy("");
        setProgress(0);
        setProgressDetail("");
      }, 420);
    }
  }

  function acceptFile(next: File | null) {
    setFile(next);
    setRows([]);
    setPreviewPage(1);
    setServerIssues([]);
    setDocumentInfo(null);
    setLastError(null);
    setProgressDetail("");
    setRulePreview(null);
    setRuleActionNotice(next ? "文件已就绪，可在规则配置中 AI 生成或预解析规则。" : "");
  }

  function recordImportError(title: string, message: string) {
    setLastError({
      title,
      message,
      fileName: file?.name,
      fileSize: file?.size,
      fileType: file?.type || file?.name.split(".").pop()?.toUpperCase()
    });
  }

  function selectRule(ruleId: string) {
    setSelectedRuleId(ruleId);
    setAiProvider(null);
    setRulePreview(null);
    setRuleActionNotice(ruleId ? "已切换规则模板，请用当前文件预解析确认。" : "已切换到空白规则草稿。");
    if (!ruleId) setRuleDraft(stringifyRuleDraft(createBlankRule()));
  }

  function createNewRuleDraft() {
    setSelectedRuleId("");
    setAiProvider(null);
    setRulePreview(null);
    setAiPromptDraft(DEFAULT_LLM_PROMPT);
    setRuleDraft(stringifyRuleDraft(createBlankRule()));
    setRuleActionNotice("已创建空白规则草稿，可编辑 JSON 或使用 AI 生成。");
  }

  function copyRule() {
    const parsed = parseRuleDraft(ruleDraft);
    if (!parsed) {
      showToast("error", "当前规则 JSON 不合法，无法复制。");
      return;
    }
    const now = nowIso();
    const copied = { ...parsed, id: makeId("rule"), name: `${parsed.name} 副本`, createdAt: now, updatedAt: now };
    setSelectedRuleId("");
    setRuleDraft(stringifyRuleDraft(copied));
    setRuleActionNotice("已复制为新规则草稿，保存后才会进入规则列表。");
    showToast("info", "已复制为新规则草稿。");
  }

  async function generateRule() {
    if (!file) {
      setRuleActionNotice("请先在主界面上传一个样例文件。");
      showToast("error", "请先上传文件。");
      return;
    }
    if (!selectedProfileId) {
      setRuleActionNotice("AI 生成规则前需要先选择模型 Profile。");
      showToast("error", "AI 生成规则前请先选择模型 Profile。");
      openModelConfig();
      return;
    }
    if (!selectedProfileUsable) {
      setRuleActionNotice("当前模型 Profile 未配置 Key 或不可用，请先配置并测试。");
      showToast("error", "当前模型 Profile 未配置 Key 或不可用，请先配置并测试。");
      openModelConfig(selectedProfileId);
      return;
    }
    setRuleActionNotice("AI 正在分析文件结构并生成规则，请稍候。");
    await runWithProgress("AI 正在分析文件并生成规则", async () => {
      setProgressDetail("读取样例 0/1");
      const form = new FormData();
      form.append("file", file);
      if (selectedProfileId) form.append("profileId", selectedProfileId);
      form.append("prompt", aiPromptDraft);
      const response = await fetch("/api/rules/generate", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "生成规则失败");
      setDocumentInfo(data.document);
      setAiProvider(data.provider);
      setRuleDraft(stringifyRuleDraft(data.rule));
      setSelectedRuleId("");
      setRuleConfigOpen(true);
      setProgressDetail(`样例分析完成 ${data.document?.stats?.rowCount || 1}/${data.document?.stats?.rowCount || 1}`);
      setRuleActionNotice(data.provider === "llm" ? "AI 已生成推荐规则，正在自动预解析。" : "模型不可用，已使用本地推荐规则，正在自动预解析。");
      try {
        setProgressDetail("自动预解析 0/1");
        const preview = await parseFileWithRule(data.rule);
        applyParseResult(preview, false);
      } catch (previewError) {
        const message = previewError instanceof Error ? previewError.message : "自动预解析失败。";
        setRuleActionNotice(`AI 已生成规则，但自动预解析失败：${message}`);
        showToast("error", message);
      }
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "生成规则失败。";
      setRuleActionNotice(`AI 生成规则失败：${message}`);
      recordImportError("AI 生成规则失败", message);
      showToast("error", message);
    });
  }

  async function parseFileWithRule(parsedRule: ParsingRule) {
    if (!file) throw new Error("请先上传文件。");
    const form = new FormData();
    form.append("file", file);
    form.append("rule", JSON.stringify(parsedRule));
    const response = await fetch("/api/parse", { method: "POST", body: form });
    const data = (await response.json()) as { document?: IntermediateDocument; result?: ParseResult; error?: string };
    if (!response.ok) throw new Error(data.error || "解析失败");
    return data;
  }

  function applyParseResult(data: { document?: IntermediateDocument; result?: ParseResult }, syncToMain: boolean) {
    const nextRows = data.result?.rows || [];
    const nextIssues = data.result?.issues || [];
    const emptyResultIssue = nextIssues.find((issue) => issue.id === "parse_empty_result");
    setDocumentInfo(data.document || null);
    setLastError(null);
    setRulePreview({ rows: nextRows, issues: nextIssues, elapsedMs: data.result?.elapsedMs });
    const sourceTotal = data.document?.stats.rowCount || nextRows.length;
    setProgressDetail(`已处理 ${sourceTotal}/${sourceTotal} 源数据行，产出 ${nextRows.length} 明细行`);
    if (syncToMain) {
      setRows(nextRows);
      setPreviewPage(1);
      setServerIssues(nextIssues);
    }
    if (emptyResultIssue) {
      if (!syncToMain) setRuleActionNotice(`预解析未产出明细：${emptyResultIssue.message}`);
      showToast("error", emptyResultIssue.message);
    } else {
      if (!syncToMain) setRuleActionNotice(`预解析完成：${nextRows.length} 行，${nextIssues.length} 个问题。`);
      showToast("success", syncToMain ? `解析完成：${nextRows.length} 行，${nextIssues.length} 个问题。` : `预解析完成：${nextRows.length} 行，${nextIssues.length} 个问题。`);
    }
  }

  async function saveCurrentRule() {
    try {
      setRuleActionNotice("正在保存规则模板...");
      const parsed = JSON.parse(ruleDraft) as ParsingRule;
      const normalizedRule = selectedRuleIsBuiltIn
        ? { ...parsed, id: makeId("rule"), name: `${parsed.name} 自定义副本`, createdAt: nowIso(), updatedAt: nowIso(), builtIn: undefined }
        : { ...parsed, builtIn: undefined };
      const response = await fetch("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...normalizedRule, generationPrompt: aiPromptDraft || DEFAULT_LLM_PROMPT })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存规则失败");
      await loadRules();
      setSelectedRuleId(data.rule.id);
      setRuleActionNotice(selectedRuleIsBuiltIn ? "内置规则已另存为自定义副本，可继续微调。" : "规则模板已保存，可在主界面选择后解析全部文件。");
      showToast("success", selectedRuleIsBuiltIn ? "已另存为自定义规则副本。" : "规则模板已保存。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "规则 JSON 不合法。";
      setRuleActionNotice(`保存失败：${message}`);
      showToast("error", message);
    }
  }

  async function deleteCurrentRule() {
    if (!selectedRuleId) return;
    if (selectedRuleIsBuiltIn) {
      setRuleActionNotice("内置规则不能删除；如需回退，请使用恢复默认。");
      showToast("info", "内置规则不能删除，可恢复默认或复制后修改。");
      return;
    }
    setRuleActionNotice("正在删除规则模板...");
    const response = await fetch(`/api/rules?id=${selectedRuleId}`, { method: "DELETE" });
    if (response.ok) {
      createNewRuleDraft();
      await loadRules();
      setRuleActionNotice("规则模板已删除，当前为新的空白草稿。");
      showToast("success", "规则模板已删除。");
    } else {
      setRuleActionNotice("删除失败，请稍后重试。");
    }
  }

  async function restoreCurrentDefaultRule() {
    if (!selectedRuleId || !selectedRuleIsBuiltIn) return;
    try {
      setRuleActionNotice("正在恢复内置规则默认值...");
      setRulePreview(null);
      const response = await fetch("/api/rules/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedRuleId })
      });
      const data = (await response.json()) as { rule?: ParsingRule; error?: string };
      if (!response.ok || !data.rule) throw new Error(data.error || "恢复内置规则失败");
      await loadRules();
      setSelectedRuleId(data.rule.id);
      setRuleDraft(stringifyRuleDraft(data.rule));
      setAiPromptDraft(data.rule.generationPrompt || DEFAULT_LLM_PROMPT);
      setAiProvider(null);
      setRuleActionNotice("已恢复为系统内置调优规则，请用当前文件预解析确认。");
      showToast("success", "已恢复内置规则默认值。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "恢复内置规则失败。";
      setRuleActionNotice(`恢复失败：${message}`);
      showToast("error", message);
    }
  }

  async function parseRuleFile(syncToMain: boolean) {
    if (!file) {
      if (!syncToMain) setRuleActionNotice("请先在主界面上传一个样例文件。");
      showToast("error", "请先上传文件。");
      return;
    }
    if (!hasExecutableRule) {
      if (!syncToMain) setRuleActionNotice("请先选择、编辑或 AI 生成可执行规则。");
      showToast("error", "请先选择或生成规则模板。");
      return;
    }
    if (!syncToMain) setRuleActionNotice("正在用当前文件预解析规则，请稍候。");
    await runWithProgress(syncToMain ? "正在解析全部文件" : "正在预解析当前文件", async () => {
      setProgressDetail("上传解析 0/1");
      const parsedRule = JSON.parse(ruleDraft) as ParsingRule;
      const data = await parseFileWithRule(parsedRule);
      applyParseResult(data, syncToMain);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "解析失败。";
      if (!syncToMain) setRuleActionNotice(`预解析失败：${message}`);
      recordImportError(syncToMain ? "解析全部文件失败" : "预解析失败", message);
      showToast("error", message);
    });
  }

  function selectProfile(profileId: string) {
    setSelectedProfileId(profileId);
  }

  function editProfile(profileId: string) {
    setTestState("idle");
    setTestMessage("");
    setProfileFieldErrors({});
    const profile = llmProfiles.find((item) => item.id === profileId);
    if (profile) {
      setSelectedProfileId(profile.id);
      setProfileDraft(draftFromProfile(profile));
      return;
    }
    setSelectedProfileId("");
    setProfileDraft(createBlankProfile());
  }

  function openModelConfig(profileId = selectedProfileId) {
    const fallbackId = profileId || llmProfiles.find((profile) => profile.enabled !== false)?.id || llmProfiles[0]?.id || "";
    editProfile(fallbackId);
    setModelConfigOpen(true);
  }

  function updateProfile<K extends keyof LlmProfileDraft>(key: K, value: LlmProfileDraft[K]) {
    setProfileDraft((current) => ({ ...current, [key]: value }));
    if (isProfileRequiredField(key)) {
      setProfileFieldErrors((current) => {
        const { [key]: _removed, ...rest } = current;
        return rest;
      });
    }
    setTestState("idle");
    setTestMessage("");
  }

  function updateProfileProtocol(protocol: LlmProtocol) {
    const defaults = protocolOptions.find((option) => option.value === protocol) || protocolOptions[0];
    setProfileFieldErrors((current) => {
      const { baseUrl: _baseUrl, model: _model, ...rest } = current;
      return rest;
    });
    setProfileDraft((current) => ({
      ...current,
      protocol,
      baseUrl:
        current.baseUrl === "https://api.deepseek.com" ||
        current.baseUrl === "https://api.minimax.io/anthropic" ||
        current.baseUrl === MINIMAX_OPENAI_BASE_URL ||
        current.baseUrl === MINIMAX_ANTHROPIC_BASE_URL ||
        current.baseUrl === MINIMAX_NATIVE_BASE_URL
          ? defaults.baseUrl
          : current.baseUrl,
      model: current.model === "deepseek-chat" || current.model === "MiniMax-M3" ? defaults.model : current.model
    }));
    setTestState("idle");
    setTestMessage("");
  }

  async function saveProfile() {
    if (profileDraft.source === "env") {
      showToast("info", "环境变量 Profile 不需要保存，可新建数据库 Profile。");
      return;
    }
    if (profileSaving) return;

    const normalizedProfile = normalizeProfileDraft(profileDraft);
    const nextErrors = validateProfileDraft(normalizedProfile, canUseSavedKey);
    setProfileDraft(normalizedProfile);
    setProfileFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      const message = firstProfileErrorMessage(nextErrors);
      setTestState("error");
      setTestMessage(message);
      showToast("error", message);
      return;
    }

    setProfileSaving(true);
    setTestState("testing");
    setTestMessage("正在保存模型 Profile...");
    try {
      const response = await fetch("/api/llm-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...normalizedProfile,
          keepExistingKey: canUseSavedKey && !normalizedProfile.apiKey
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存模型 Profile 失败");
      await loadProfiles();
      setSelectedProfileId(data.profile.id);
      setProfileDraft(draftFromProfile(data.profile));
      setProfileFieldErrors({});
      setTestState("success");
      setTestMessage("模型 Profile 已保存。");
      showToast("success", "模型 Profile 已保存。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存模型 Profile 失败。";
      setTestState("error");
      setTestMessage(message);
      showToast("error", message);
    } finally {
      setProfileSaving(false);
    }
  }

  async function deleteProfile() {
    if (!editingExistingProfile || profileDraft.source === "env") return;
    const response = await fetch(`/api/llm-profiles?id=${profileDraft.id}`, { method: "DELETE" });
    if (response.ok) {
      if (selectedProfileId === profileDraft.id) setSelectedProfileId("");
      setProfileDraft(createBlankProfile());
      await loadProfiles();
      showToast("success", "模型 Profile 已删除。");
    }
  }

  async function testProfile() {
    const normalizedProfile = normalizeProfileDraft(profileDraft);
    const nextErrors = validateProfileDraft(normalizedProfile, canUseSavedKey);
    setProfileDraft(normalizedProfile);
    setProfileFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      const message = firstProfileErrorMessage(nextErrors);
      setTestState("error");
      setTestMessage(message);
      showToast("error", message);
      return;
    }

    setTestState("testing");
    setTestMessage("正在测试连接...");
    try {
      const response = await fetch("/api/llm-profiles/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: normalizedProfile.id || undefined,
          protocol: normalizedProfile.protocol,
          baseUrl: normalizedProfile.baseUrl,
          model: normalizedProfile.model,
          apiKey: normalizedProfile.apiKey,
          temperature: normalizedProfile.temperature,
          timeoutMs: normalizedProfile.timeoutMs,
          keepExistingKey: canUseSavedKey && !normalizedProfile.apiKey
        })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "测试失败");
      setTestState("success");
      setTestMessage(
        data.warning
          ? `连接可用：${data.model || normalizedProfile.model}（${data.protocol || normalizedProfile.protocol}）。${data.warning}`
          : `连接可用：${data.model || normalizedProfile.model}（${data.protocol || normalizedProfile.protocol}）`
      );
    } catch (error) {
      setTestState("error");
      setTestMessage(error instanceof Error ? error.message : "测试失败");
    }
  }

  function updateCell(rowId: string, field: OrderField, value: string) {
    setRows((current) =>
      current.map((row) =>
        row.id === rowId
          ? {
              ...row,
              [field]: field === "skuQuantity" ? value : value
            }
          : row
      )
    );
  }

  function focusCell(rowIndex: number, fieldIndex: number) {
    const nextRowIndex = Math.max(0, Math.min(pagedRows.length - 1, rowIndex));
    const nextFieldIndex = Math.max(0, Math.min(editableFields.length - 1, fieldIndex));
    virtualizer.scrollToIndex(nextRowIndex, { align: "auto" });
    window.setTimeout(() => {
      const selector = `[data-row-index="${nextRowIndex}"][data-field-index="${nextFieldIndex}"]`;
      const input = parentRef.current?.querySelector<HTMLInputElement>(selector);
      input?.focus();
      input?.select();
    }, 30);
  }

  function handleCellKeyDown(event: React.KeyboardEvent<HTMLInputElement>, rowIndex: number, fieldIndex: number) {
    const lastFieldIndex = editableFields.length - 1;
    if (event.key === "Tab") {
      event.preventDefault();
      const step = event.shiftKey ? -1 : 1;
      const flatIndex = rowIndex * editableFields.length + fieldIndex + step;
      const maxIndex = pagedRows.length * editableFields.length - 1;
      const nextFlatIndex = Math.max(0, Math.min(maxIndex, flatIndex));
      focusCell(Math.floor(nextFlatIndex / editableFields.length), nextFlatIndex % editableFields.length);
    }
    if (event.key === "Enter") {
      event.preventDefault();
      focusCell(event.shiftKey ? rowIndex - 1 : rowIndex + 1, fieldIndex);
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusCell(rowIndex + 1, fieldIndex);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusCell(rowIndex - 1, fieldIndex);
    }
    if (event.key === "ArrowRight" && event.currentTarget.selectionStart === event.currentTarget.value.length) {
      event.preventDefault();
      focusCell(rowIndex, fieldIndex + 1 > lastFieldIndex ? lastFieldIndex : fieldIndex + 1);
    }
    if (event.key === "ArrowLeft" && event.currentTarget.selectionStart === 0) {
      event.preventDefault();
      focusCell(rowIndex, fieldIndex - 1);
    }
  }

  function startPreviewColumnResize(event: React.MouseEvent<HTMLElement>, column: PreviewColumnKey) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = previewColumnWidths[column];
    const minWidth = column === "rowIndex" ? 54 : column === "action" ? 60 : 96;

    const handleMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.max(minWidth, Math.round(startWidth + moveEvent.clientX - startX));
      setPreviewColumnWidths((current) => ({ ...current, [column]: nextWidth }));
    };
    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }

  function addRow() {
    const nextRow = {
      id: makeId("row"),
      rowNumber: 1,
      skuCode: "",
      skuName: "",
      skuQuantity: 0
    };
    setPreviewPage(1);
    setRows((current) => {
      return [nextRow, ...current].map((row, index) => ({ ...row, rowNumber: index + 1 }));
    });
    window.setTimeout(() => {
      virtualizer.scrollToIndex(0, { align: "start" });
      const input = parentRef.current?.querySelector<HTMLInputElement>('[data-row-index="0"][data-field-index="0"]');
      input?.focus();
      input?.select();
    }, 60);
  }

  function deleteRow(rowId: string) {
    setRows((current) => current.filter((row) => row.id !== rowId).map((row, index) => ({ ...row, rowNumber: index + 1 })));
  }

  async function exportRows() {
    if (!rows.length) return;
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows })
    });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `orders-${Date.now()}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function submitRows() {
    if (!rows.length) return;
    if (errorCount > 0) {
      showToast("error", "存在错误行，请修正后再提交。");
      return;
    }
    await runWithProgress("正在提交下单", async () => {
      const submitTotal = groupsCount || rows.length;
      setProgressDetail(`待提交 0/${submitTotal} 单`);
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows })
      });
      const data = await response.json();
      if (!response.ok) {
        setServerIssues(data.issues || []);
        throw new Error(data.issues?.[0]?.message || data.error || "提交失败");
      }
      setProgressDetail(`提交完成 ${data.successCount}/${submitTotal} 单，失败 ${data.failureCount} 单`);
      await openLatestHistory();
      showToast("success", `提交成功 ${data.successCount} 单，失败 ${data.failureCount} 单。`);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "提交失败。";
      recordImportError("提交下单失败", message);
      showToast("error", message);
    });
  }

  return (
    <main className="opm-preview importer-app embedded-importer">
      <section className="opm-workbench">
        <div className="opm-main">
          <header className="module-header">
            <div>
              <h1>万能导入管理</h1>
              <p>上传文件后选择规则模板，配置里预解析确认规则，主页全量解析后提交下单。</p>
            </div>
            <Link className="async-entry-link" href="/import-tasks"><Activity size={15} />异步任务与监控</Link>
          </header>

          {busy && (
            <div className="progress-wrap importer-progress">
              <div className="progress-copy"><Loader2 size={16} className="spin" />{busy}<span>{progressDetail || `${Math.round(progress)}%`}</span></div>
              <div className="progress-track"><div style={{ width: `${progress}%` }} /></div>
            </div>
          )}

          <section className="status-strip">
            <span>{health ? (health.storage === "database" ? "数据库已连接" : "本地存储") : rulesLoaded || profilesLoaded ? "数据服务已连接" : "正在连接存储"}</span>
            <span>{profilesLoaded ? (llmProfiles.length ? `模型 Profile ${llmProfiles.length}` : "未配置模型 Profile") : "模型 Profile 加载中"}</span>
            <span>{rulesLoaded ? `规则模板 ${rules.length}` : "规则模板加载中"}</span>
            <span>预览 {rows.length} 行</span>
            <span>出库单 {groupsCount}</span>
            <span className={errorCount ? "danger-text" : "ok-text"}>错误 {errorCount}</span>
            <span className="warn">警告 {warningCount}</span>
          </section>

          <section className="import-command-bar">
            <div className="upload-field">
              <span>上传文件</span>
              <label
                className={`compact-upload ${dragActive ? "drag-active" : ""}`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setDragActive(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragActive(false);
                  acceptFile(event.dataTransfer.files?.[0] || null);
                }}
              >
                <UploadCloud size={15} />
                <span>{file ? file.name : "请选择文件"}</span>
                <input type="file" accept=".xlsx,.xls,.docx,.pdf" onChange={(event) => acceptFile(event.target.files?.[0] || null)} />
              </label>
            </div>
            <label>
              <span>规则模板</span>
              <select value={selectedRuleId} onChange={(event) => selectRule(event.target.value)}>
                <option value="">请选择已有规则</option>
                {rules.map((rule) => (
                  <option key={rule.id} value={rule.id}>{rule.name}</option>
                ))}
              </select>
            </label>
            <button onClick={() => setRuleConfigOpen(true)}><Settings2 size={14} /> 规则配置</button>
            <button
              type="button"
              onClick={() => openModelConfig()}
            >
              <Bot size={14} /> 模型配置
            </button>
            <button className="primary" onClick={() => void parseRuleFile(true)} disabled={!file || !hasExecutableRule || Boolean(busy)}><Search size={14} /> 解析全部文件</button>
          </section>

          {documentInfo && (
            <section className="doc-compact-stats">
              <span>文件类型：{documentInfo.sourceKind.toUpperCase()}</span>
              <span>Sheet：{documentInfo.stats.sheetCount}</span>
              <span>源数据行：{documentInfo.stats.rowCount}</span>
              <span>字符：{documentInfo.stats.charCount}</span>
            </section>
          )}

          {lastError && (
            <section className="import-error-panel">
              <div>
                <strong>{lastError.title}</strong>
                <span>{lastError.message}</span>
                <small>
                  原始文件：{lastError.fileName || "-"}
                  {lastError.fileSize ? ` · ${(lastError.fileSize / 1024).toFixed(1)} KB` : ""}
                  {lastError.fileType ? ` · ${lastError.fileType}` : ""}
                </small>
              </div>
              <button type="button" onClick={() => setRuleConfigOpen(true)}>
                <Settings2 size={14} /> 手动配置规则
              </button>
            </section>
          )}

          <section className="importer-preview single-preview">
              <div className="importer-section-head importer-preview-head">
                  <CheckCircle2 size={18} />
                  <div>
                  <strong>导入明细预览与在线编辑</strong>
                  <span>解析后的明细数据在这里分页预览、校验和修正。</span>
                </div>
                <div className="importer-actions">
                  <button type="button" onClick={() => void openLatestHistory()}><History size={14} /> 已导入</button>
                  <button onClick={addRow}><Plus size={14} /> 新增行</button>
                  <button onClick={() => void exportRows()} disabled={!rows.length}><Download size={14} /> 导出</button>
                  <button className="primary" onClick={() => void submitRows()} disabled={!rows.length || errorCount > 0 || Boolean(busy)}><Send size={14} /> 提交下单</button>
                </div>
              </div>

              <div className="importer-issues">
                <div className="importer-section-head">
                  <AlertCircle size={17} />
                  <div>
                    <strong>全量校验结果</strong>
                    <span>错误 {errorCount}，警告 {warningCount}</span>
                  </div>
                </div>
                {issues.length === 0 ? (
                  <div className="ok-line"><CheckCircle2 size={16} />暂无错误</div>
                ) : (
                  <div className="issue-list">
                    {issues.map((issue) => (
                      <div key={issue.id} className={`issue ${issue.severity}`}>
                        <span>{issue.severity === "error" ? "错误" : "警告"}</span>
                        第 {issue.rowNumber || "-"} 行{issue.field ? ` · ${ORDER_FIELD_LABELS[issue.field as OrderField] || issue.field}` : ""}：{issue.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="table-shell" ref={parentRef}>
                <div className="data-table" style={{ height: `${virtualizer.getTotalSize() + 44}px`, minWidth: `${previewTableWidth}px`, width: `${previewTableWidth}px` }}>
                  <div className="table-row table-header" style={{ gridTemplateColumns: previewGridTemplate }}>
                    <div className="row-index resizable-head" title="#">
                      <span>#</span>
                      <span className="column-resizer" aria-hidden="true" onMouseDown={(event) => startPreviewColumnResize(event, "rowIndex")} />
                    </div>
                    {editableFields.map((field) => (
                      <div key={field} className="resizable-head" title={ORDER_FIELD_LABELS[field]}>
                        <span>{ORDER_FIELD_LABELS[field]}</span>
                        <span className="column-resizer" aria-hidden="true" onMouseDown={(event) => startPreviewColumnResize(event, field)} />
                      </div>
                    ))}
                    <div className="row-action-head resizable-head" title="操作">
                      <span>操作</span>
                      <span className="column-resizer" aria-hidden="true" onMouseDown={(event) => startPreviewColumnResize(event, "action")} />
                    </div>
                  </div>
                  {rows.length === 0 && (
                    <div className="empty-state">
                      <FileSpreadsheet size={42} />
                      <strong>等待导入明细</strong>
                      <span>先上传文件，选择或配置规则后，点击主页“解析全部文件”展示明细。</span>
                    </div>
                  )}
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const row = pagedRows[virtualRow.index];
                    return (
                      <div
                        key={row.id}
                        className="table-row table-data-row"
                        style={{ gridTemplateColumns: previewGridTemplate, transform: `translateY(${virtualRow.start}px)` }}
                      >
                        <div className="row-index" title={`源文件行：${row.rowNumber || "-"}`}>{previewStart + virtualRow.index}</div>
                        {editableFields.map((field, fieldIndex) => (
                          <input
                            key={field}
                            data-row-index={virtualRow.index}
                            data-field-index={fieldIndex}
                            className={isIssueFor(issues, row.id, field) ? "cell-error" : ""}
                            value={String(row[field] ?? "")}
                            title={String(row[field] ?? "")}
                            onChange={(event) => updateCell(row.id, field, event.target.value)}
                            onKeyDown={(event) => handleCellKeyDown(event, virtualRow.index, fieldIndex)}
                          />
                        ))}
                        <button className="danger icon-only row-action" title="删除行" onClick={() => deleteRow(row.id)}><Trash2 size={15} /></button>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="preview-pagination">
                <span>共 {rows.length} 条</span>
                <span>{previewStart}-{previewEnd}</span>
                <details className="custom-page-size">
                  <summary>{previewPageSize} 条/页</summary>
                  <div>
                    {[20, 50, 100].map((size) => (
                      <button
                        key={size}
                        className={previewPageSize === size ? "active" : ""}
                        type="button"
                        onClick={(event) => {
                          setPreviewPageSize(size);
                          setPreviewPage(1);
                          event.currentTarget.closest("details")?.removeAttribute("open");
                        }}
                      >
                        {size} 条/页
                      </button>
                    ))}
                  </div>
                </details>
                <button disabled={previewPage <= 1} onClick={() => setPreviewPage((page) => Math.max(1, page - 1))}>上一页</button>
                <button className="active">{previewPage}</button>
                <button disabled={previewPage >= previewTotalPages} onClick={() => setPreviewPage((page) => Math.min(previewTotalPages, page + 1))}>下一页</button>
                <span>前往</span>
                <input
                  value={previewPage}
                  onChange={(event) => {
                    const next = Number(event.target.value) || 1;
                    setPreviewPage(Math.max(1, Math.min(previewTotalPages, next)));
                  }}
                  aria-label="跳转页码"
                />
                <span>页 / {previewTotalPages}</span>
              </div>

          </section>

          {ruleConfigOpen && (
            <div className="history-modal-backdrop" role="presentation" onClick={() => setRuleConfigOpen(false)}>
              <section className="model-modal rule-config-modal" role="dialog" aria-modal="true" aria-label="规则配置" onClick={(event) => event.stopPropagation()}>
                <div className="importer-section-head importer-preview-head">
                  <Settings2 size={18} />
                  <div>
                    <strong>规则配置</strong>
                    <span>选择规则、AI 生成、编辑 JSON，并按当前文件解析预览。</span>
                  </div>
                  <div className="importer-actions">
                    <button onClick={createNewRuleDraft} disabled={Boolean(busy)} title="新增规则草稿"><Plus size={14} /> 新增</button>
                    <button onClick={copyRule} disabled={Boolean(busy)} title="复制当前规则为草稿"><Copy size={14} /> 复制</button>
                    {selectedRuleIsBuiltIn && (
                      <button onClick={() => void restoreCurrentDefaultRule()} disabled={Boolean(busy)} title="恢复为系统内置调优规则">
                        <RotateCcw size={14} /> 恢复默认
                      </button>
                    )}
                    <button onClick={() => void generateRule()} disabled={!file || !aiPromptDraft.trim() || !selectedProfileUsable || Boolean(busy)} title="按当前文件和提示词生成推荐规则">
                      {isGeneratingRule ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
                      {isGeneratingRule ? "生成中" : "AI 生成规则"}
                    </button>
                    <button onClick={() => void parseRuleFile(false)} disabled={!file || !hasExecutableRule || Boolean(busy)} title="用当前文件预解析规则">
                      {isRulePreParsing ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
                      {isRulePreParsing ? "预解析中" : "预解析"}
                    </button>
                    <button onClick={() => void saveCurrentRule()} disabled={!ruleDraft || Boolean(busy)}><Save size={14} /> 保存</button>
                    <button className="danger icon-only" title="删除规则" onClick={() => void deleteCurrentRule()} disabled={!selectedRuleId || Boolean(busy)}><Trash2 size={15} /></button>
                    <button className="icon-only" title="关闭" onClick={() => setRuleConfigOpen(false)}><X size={16} /></button>
                  </div>
                </div>

                {(busy || ruleActionNotice) && (
                  <div className={`rule-action-status ${busy ? "active" : ""}`}>
                    {busy ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
                    <span title={busy || ruleActionNotice}>{busy || ruleActionNotice}</span>
                    {busy && <em>{progressDetail || `${Math.round(progress)}%`}</em>}
                  </div>
                )}

                <div className="rule-config-body">
                  <aside className="rule-edit-panel">
                    <label className="modal-field">
                      <span>规则模板</span>
                      <div className="rule-select-row">
                        <select value={selectedRuleId} onChange={(event) => selectRule(event.target.value)}>
                          <option value="">请选择已有规则</option>
                          {rules.map((rule) => (
                            <option key={rule.id} value={rule.id}>{rule.name}</option>
                          ))}
                        </select>
                        {selectedRuleIsBuiltIn && (
                          <button type="button" onClick={() => void restoreCurrentDefaultRule()} disabled={Boolean(busy)} title="恢复为系统内置调优规则">
                            <RotateCcw size={14} /> 恢复默认
                          </button>
                        )}
                      </div>
                    </label>

                    {ruleSummary && (
                      <div className="rule-summary">
                        <div className="rule-summary-head">
                          <strong>{ruleSummary.name}</strong>
                          <span>{selectedRuleIsBuiltIn ? "内置规则" : ruleSummary.aiGenerated ? "AI 生成" : aiProvider === "fallback" ? "本地推荐" : "规则模板"}</span>
                        </div>
                        <div className="rule-meta-grid">
                          <span>类型：{ruleSummary.layout}</span>
                          <span>格式：{ruleSummary.sourceKind}</span>
                          <span>Sheet：{ruleSummary.sheetMode || "first"}</span>
                          <span>置信度：{Math.round((ruleSummary.confidence ?? 0) * 100)}%</span>
                          <span>映射：{ruleSummary.mappings.length} 个</span>
                          <span>聚合：{ruleSummary.groupBy || "未配置"}</span>
                        </div>
                        {Boolean(ruleSummary.assumptions?.length) && (
                          <div className="assumption-list">
                            {ruleSummary.assumptions!.slice(0, 4).map((assumption, index) => (
                              <div key={`${assumption}_${index}`}>需确认：{assumption}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <label className="json-box">
                      <span>规则 JSON</span>
                      <textarea
                        className="rule-editor"
                        value={ruleDraft}
                        onChange={(event) => setRuleDraft(event.target.value)}
                        placeholder="选择或生成规则后，可在这里人工微调字段映射..."
                      />
                    </label>
                  </aside>

                  <section className="rule-runtime-panel">
                    <div className="ai-inline-panel">
                      <div className="rule-test-head">
                        <strong>AI 生成规则</strong>
                        <span>{selectedProfileUsable ? "模型可用" : selectedProfileId ? "模型未配置 Key" : "请选择模型 Profile"}</span>
                      </div>
                      <div className="ai-profile-row">
                        <select value={selectedProfileId} onChange={(event) => selectProfile(event.target.value)}>
                          <option value="">请选择模型</option>
                          {llmProfiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {profile.name} / {protocolLabel(profile.protocol)} / {profile.model}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => openModelConfig()}
                        >
                          <Bot size={14} /> 模型配置
                        </button>
                      </div>
                      <details className="ai-prompt-details">
                        <summary>提示词配置</summary>
                        <textarea
                          value={aiPromptDraft}
                          onChange={(event) => setAiPromptDraft(event.target.value)}
                          placeholder="描述希望大模型如何分析文件结构、输出规则 JSON 和标注推测字段..."
                        />
                      </details>
                    </div>

                    <div className="rule-test-panel">
                      <div className="rule-test-head">
                        <strong>解析预览</strong>
                        <span>{rulePreview ? `${rulePreview.rows.length} 行 / ${rulePreview.issues.length} 个问题` : "用当前文件试跑规则"}</span>
                      </div>
                      {!file ? (
                        <div className="rule-test-empty">请先在主界面上传文件。</div>
                      ) : !rulePreview ? (
                        <div className="rule-test-empty">点击“预解析”后，结果只展示在这里，用于保存前确认规则。</div>
                      ) : (
                        <>
                          <div className="rule-test-stats">
                            <span>预解析 {rulePreview.rows.length} 行</span>
                            <span>耗时 {formatMs(rulePreview.elapsedMs)}</span>
                            <span>错误 {rulePreview.issues.filter((issue) => issue.severity === "error").length}</span>
                            <span>警告 {rulePreview.issues.filter((issue) => issue.severity === "warning").length}</span>
                          </div>
                          <div className="rule-test-table">
                            <div className="rule-test-row head">
                              <span title="#">#</span>
                              <span title="外部编码">外部编码</span>
                              <span title="收件人">收件人</span>
                              <span title="SKU">SKU</span>
                              <span title="数量">数量</span>
                            </div>
                            {rulePreview.rows.length === 0 ? (
                              <div className="rule-test-empty">当前规则未解析出明细。</div>
                            ) : (
                              rulePreview.rows.slice(0, 80).map((row) => (
                                <div className="rule-test-row" key={row.id}>
                                  <span title={String(row.rowNumber)}>{row.rowNumber}</span>
                                  <span title={row.externalCode || ""}>{row.externalCode || "-"}</span>
                                  <span title={row.recipientName || ""}>{row.recipientName || "-"}</span>
                                  <span title={row.skuCode || row.skuName || ""}>{row.skuCode || row.skuName || "-"}</span>
                                  <span title={String(row.skuQuantity || "-")}>{row.skuQuantity || "-"}</span>
                                </div>
                              ))
                            )}
                          </div>
                          {rulePreview.rows.length > 80 && <div className="rule-test-empty">已展示前 80 行；正式解析请回主页点击“解析全部文件”。</div>}
                          {rulePreview.issues.length > 0 && (
                            <div className="rule-test-issues">
                              {rulePreview.issues.slice(0, 5).map((issue) => (
                                <div key={issue.id} title={`${issue.severity === "error" ? "错误" : "警告"}：第 ${issue.rowNumber || "-"} 行 ${issue.message}`}>{issue.severity === "error" ? "错误" : "警告"}：第 {issue.rowNumber || "-"} 行 {issue.message}</div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </section>
                </div>
              </section>
            </div>
          )}

          {modelConfigOpen && (
            <div className="history-modal-backdrop" role="presentation" onClick={() => setModelConfigOpen(false)}>
              <section className="model-modal" role="dialog" aria-modal="true" aria-label="模型 Profile 配置" onClick={(event) => event.stopPropagation()}>
                <div className="importer-section-head importer-preview-head">
                  <Bot size={18} />
                  <div>
                    <strong>模型 Profile 配置</strong>
                    <span>Profile 从数据库动态查询，API Key 只在服务端保存和调用。</span>
                  </div>
                  <div className="importer-actions">
                    <button onClick={() => editProfile("")}><Plus size={14} /> 新增</button>
                    <button onClick={() => void loadProfiles()}><RefreshCw size={14} /> 查询</button>
                    <button className="icon-only" title="关闭" onClick={() => setModelConfigOpen(false)}><X size={16} /></button>
                  </div>
                </div>

                <div className="model-manager">
                  <aside className="profile-list-panel">
                    <div className="profile-list-head">
                      <strong>Profile 列表</strong>
                      <span>{llmProfiles.length} 条</span>
                    </div>
                    <div className="profile-list">
                      {llmProfiles.length === 0 ? (
                        <div className="empty-profile">暂无模型 Profile</div>
                      ) : (
                        llmProfiles.map((profile) => (
                          <button
                            key={profile.id}
                            className={`profile-item ${profileDraft.id === profile.id ? "active" : ""}`}
                            onClick={() => editProfile(profile.id)}
                          >
                            <strong>{profile.name}</strong>
                            <span>{profile.model}</span>
                            <small>{profileProtocolBadge(profile.protocol)}</small>
                            <em>{profile.hasApiKey ? "Key 已保存" : "未配置 Key"}</em>
                          </button>
                        ))
                      )}
                    </div>
                  </aside>

                  <section className="profile-edit-panel">
                    <div className="model-form">
                      <label className={profileFieldErrors.name ? "has-error" : ""}>
                        <span>名称</span>
                        <input
                          value={profileDraft.name}
                          onChange={(event) => updateProfile("name", event.target.value)}
                          disabled={profileDraft.source === "env"}
                          aria-invalid={Boolean(profileFieldErrors.name)}
                          required
                        />
                        {profileFieldErrors.name && <em className="field-error">{profileFieldErrors.name}</em>}
                      </label>
                      <label>
                        <span>接口协议</span>
                        <select
                          value={profileDraft.protocol}
                          onChange={(event) => updateProfileProtocol(event.target.value as LlmProtocol)}
                          disabled={profileDraft.source === "env"}
                        >
                          {protocolOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className={profileFieldErrors.baseUrl ? "has-error" : ""}>
                        <span>API URL</span>
                        <input
                          value={profileDraft.baseUrl}
                          onChange={(event) => updateProfile("baseUrl", event.target.value)}
                          aria-invalid={Boolean(profileFieldErrors.baseUrl)}
                          required
                        />
                        {profileFieldErrors.baseUrl && <em className="field-error">{profileFieldErrors.baseUrl}</em>}
                      </label>
                      <label className={profileFieldErrors.apiKey ? "has-error" : ""}>
                        <span>API Key</span>
                        <input
                          type="password"
                          value={profileDraft.apiKey}
                          onChange={(event) => updateProfile("apiKey", event.target.value)}
                          placeholder={canUseSavedKey ? "已保存，留空则继续使用原 Key" : "请输入 API Key"}
                          disabled={profileDraft.source === "env"}
                          aria-invalid={Boolean(profileFieldErrors.apiKey)}
                          required={!canUseSavedKey}
                        />
                        {profileFieldErrors.apiKey && <em className="field-error">{profileFieldErrors.apiKey}</em>}
                      </label>
                      <label className={profileFieldErrors.model ? "has-error" : ""}>
                        <span>模型名称</span>
                        <input
                          value={profileDraft.model}
                          onChange={(event) => updateProfile("model", event.target.value)}
                          aria-invalid={Boolean(profileFieldErrors.model)}
                          required
                        />
                        {profileFieldErrors.model && <em className="field-error">{profileFieldErrors.model}</em>}
                      </label>
                      <div className="model-inline">
                        <label>
                          <span>温度</span>
                          <input
                            type="number"
                            min="0"
                            max="2"
                            step="0.1"
                            value={profileDraft.temperature ?? 0.1}
                            onChange={(event) => updateProfile("temperature", Number(event.target.value))}
                          />
                        </label>
                        <label>
                          <span>超时 ms</span>
                          <input
                            type="number"
                            min="3000"
                            step="1000"
                            value={profileDraft.timeoutMs ?? 25000}
                            onChange={(event) => updateProfile("timeoutMs", Number(event.target.value))}
                          />
                        </label>
                      </div>
                      <label className="model-enabled">
                        <input
                          type="checkbox"
                          checked={profileDraft.enabled ?? true}
                          onChange={(event) => updateProfile("enabled", event.target.checked)}
                        />
                        <span>启用该 Profile</span>
                      </label>
                    </div>
                    <div className="model-provider-hint">
                      MiniMax-M3 推荐选择“MiniMax 原生 / chatcompletion_v2”，API URL 使用 https://api.minimaxi.com/v1/text/chatcompletion_v2。
                      测试和保存时会自动纠正 MiniMax 协议与 URL 的常见错配。
                    </div>

                    <div className="model-test-row">
                      <button className="primary" onClick={() => void testProfile()} disabled={isTestingProfile || profileSaving}>
                        {isTestingProfile ? <Loader2 size={14} className="spin" /> : <TestTube2 size={14} />}
                        {isTestingProfile ? "测试中" : "测试连接"}
                      </button>
                      {testMessage && <span className={`test-message ${testState}`}>{testMessage}</span>}
                    </div>

                    <div className="modal-footer-actions">
                      <button onClick={() => void saveProfile()} disabled={profileDraft.source === "env" || profileSaving || isTestingProfile}>
                        {profileSaving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                        {profileSaving ? "保存中" : "保存"}
                      </button>
                      <button className="danger" onClick={() => void deleteProfile()} disabled={!editingExistingProfile || profileDraft.source === "env"}><Trash2 size={14} /> 删除</button>
                    </div>
                  </section>
                </div>
              </section>
            </div>
          )}

          {historyOpen && (
            <div className="history-modal-backdrop" role="presentation" onClick={() => setHistoryOpen(false)}>
              <section className="importer-history history-modal" role="dialog" aria-modal="true" aria-label="已导入运单" onClick={(event) => event.stopPropagation()}>
                <div className="importer-section-head importer-preview-head">
                  <History size={18} />
                  <div>
                    <strong>已导入运单</strong>
                    <span>共 {history.total} 条历史记录，支持外部编码、收件人、门店和提交时间筛选。</span>
                  </div>
                  <div className="history-tools">
                    <div className="search-box">
                      <Search size={16} />
                      <input
                        value={historyFilters.query}
                        onChange={(event) => setHistoryFilters((current) => ({ ...current, query: event.target.value, page: 1 }))}
                        placeholder="外部编码 / 收件人 / 门店"
                      />
                    </div>
                    <input
                      className="date-input"
                      type="date"
                      value={historyFilters.from}
                      onChange={(event) => setHistoryFilters((current) => ({ ...current, from: event.target.value, page: 1 }))}
                      aria-label="开始提交时间"
                    />
                    <input
                      className="date-input"
                      type="date"
                      value={historyFilters.to}
                      onChange={(event) => setHistoryFilters((current) => ({ ...current, to: event.target.value, page: 1 }))}
                      aria-label="结束提交时间"
                    />
                    <button onClick={() => void loadHistory()}><Search size={16} />查询</button>
                    <button onClick={() => void resetHistoryFilters()}>重置</button>
                    <button className="icon-only" title="关闭" onClick={() => setHistoryOpen(false)}><X size={16} /></button>
                  </div>
                </div>
                <div className="history-detail-layout history-list-layout">
                  <div className="history-table-shell">
                    <div className="history-table">
                      <div className="history-table-row history-table-head">
                        <span title="外部编码">外部编码</span>
                        <span title="门店">门店</span>
                        <span title="收件人">收件人</span>
                        <span title="电话">电话</span>
                        <span title="SKU">SKU</span>
                        <span title="提交时间">提交时间</span>
                        <span title="操作">操作</span>
                      </div>
                      {history.items.length === 0 ? (
                        <div className="empty-history">暂无历史数据</div>
                      ) : (
                        history.items.map((order) => (
                          <div
                            className={`history-table-row ${selectedHistoryOrder?.id === order.id ? "selected" : ""}`}
                            key={`${order.id}_${order.submittedAt}`}
                          >
                            <span title={order.externalCode || order.id}>{order.externalCode || order.id}</span>
                            <span title={order.storeName || ""}>{order.storeName || "-"}</span>
                            <span title={order.recipientName || ""}>{order.recipientName || "-"}</span>
                            <span title={order.recipientPhone || ""}>{order.recipientPhone || "-"}</span>
                            <span title={String(order.skuLines.length)}>{order.skuLines.length}</span>
                            <span title={order.submittedAt?.slice(0, 19).replace("T", " ") || "-"}>{order.submittedAt?.slice(0, 19).replace("T", " ") || "-"}</span>
                            <span>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedHistoryId(order.id);
                                  setHistoryDetailOpen(true);
                                }}
                              >
                                查看详情
                              </button>
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
                <div className="pager">
                  <span>共 {history.total} 条</span>
                  <span>{historyStart}-{historyEnd}</span>
                  <details className="custom-page-size">
                    <summary>{historyFilters.pageSize} 条/页</summary>
                    <div>
                      {[10, 20, 50].map((size) => (
                        <button
                          key={size}
                          className={historyFilters.pageSize === size ? "active" : ""}
                          type="button"
                          onClick={(event) => {
                            setHistoryFilters((current) => ({ ...current, pageSize: size, page: 1 }));
                            event.currentTarget.closest("details")?.removeAttribute("open");
                          }}
                        >
                          {size} 条/页
                        </button>
                      ))}
                    </div>
                  </details>
                  <button
                    disabled={historyFilters.page <= 1}
                    onClick={() => setHistoryFilters((current) => ({ ...current, page: Math.max(1, current.page - 1) }))}
                  >
                    上一页
                  </button>
                  <button className="active">{historyFilters.page}</button>
                  <button
                    disabled={historyFilters.page >= historyTotalPages}
                    onClick={() => setHistoryFilters((current) => ({ ...current, page: Math.min(historyTotalPages, current.page + 1) }))}
                  >
                    下一页
                  </button>
                  <span>前往</span>
                  <input
                    value={historyFilters.page}
                    onChange={(event) => {
                      const next = Number(event.target.value) || 1;
                      setHistoryFilters((current) => ({ ...current, page: Math.max(1, Math.min(historyTotalPages, next)) }));
                    }}
                    aria-label="跳转历史页码"
                  />
                  <span>页 / {historyTotalPages}</span>
                </div>
              </section>
            </div>
          )}

          {historyDetailOpen && selectedHistoryOrder && (
            <div className="history-modal-backdrop detail-backdrop" role="presentation" onClick={() => setHistoryDetailOpen(false)}>
              <section className="history-detail-modal" role="dialog" aria-modal="true" aria-label="导入详情" onClick={(event) => event.stopPropagation()}>
                <div className="importer-section-head importer-preview-head">
                  <History size={18} />
                  <div>
                    <strong>导入详情</strong>
                    <span>{selectedHistoryOrder.externalCode || selectedHistoryOrder.id}</span>
                  </div>
                  <div className="importer-actions">
                    <button className="icon-only" title="关闭" onClick={() => setHistoryDetailOpen(false)}><X size={16} /></button>
                  </div>
                </div>
                <div className="history-detail-panel">
                  <div className="history-detail-title">
                    <strong title={selectedHistoryOrder.externalCode || selectedHistoryOrder.id}>{selectedHistoryOrder.externalCode || selectedHistoryOrder.id}</strong>
                    <span title={selectedHistoryOrder.submittedAt?.slice(0, 19).replace("T", " ") || "-"}>{selectedHistoryOrder.submittedAt?.slice(0, 19).replace("T", " ")}</span>
                  </div>
                  <dl>
                    <dt>门店</dt>
                    <dd title={selectedHistoryOrder.storeName || "-"}>{selectedHistoryOrder.storeName || "-"}</dd>
                    <dt>收件人</dt>
                    <dd title={selectedHistoryOrder.recipientName || "-"}>{selectedHistoryOrder.recipientName || "-"}</dd>
                    <dt>电话</dt>
                    <dd title={selectedHistoryOrder.recipientPhone || "-"}>{selectedHistoryOrder.recipientPhone || "-"}</dd>
                    <dt>地址</dt>
                    <dd title={selectedHistoryOrder.recipientAddress || "-"}>{selectedHistoryOrder.recipientAddress || "-"}</dd>
                  </dl>
                  <div className="history-sku-table">
                    <div className="history-sku-row header">
                      <span title="SKU">SKU</span>
                      <span title="名称">名称</span>
                      <span title="数量">数量</span>
                    </div>
                    {selectedHistoryOrder.skuLines.length === 0 ? (
                      <div className="history-sku-empty">
                        <FileSpreadsheet size={32} />
                        <strong>暂无 SKU 明细</strong>
                        <span>当前导入记录没有可展示的商品行。</span>
                      </div>
                    ) : (
                      selectedHistoryOrder.skuLines.map((line, index) => (
                        <div className="history-sku-row" key={`${line.skuCode}_${index}`}>
                          <span title={line.skuCode || "-"}>{line.skuCode || "-"}</span>
                          <span title={line.skuName || "-"}>{line.skuName || "-"}</span>
                          <span title={String(line.skuQuantity)}>{line.skuQuantity}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>
      </section>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </main>
  );
}
