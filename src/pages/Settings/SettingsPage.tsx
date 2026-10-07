import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppStore } from '../../app/store.ts'
import {
  applyPreset,
  createProvider,
  DEFAULT_PRESET_ID,
  findPreset,
  isMockPreset,
  presetWarnsAboutCors,
  PROVIDER_PRESETS,
} from '../../infrastructure/ai/factory.ts'
import { API_KEY_SESSION } from '../../infrastructure/ai/session-key.ts'
import { STATUS_LABELS, classifyError } from '../../infrastructure/ai/adapters/openai-compatible.ts'
import type { ConnectionResult, ModelInfo } from '../../infrastructure/ai/types.ts'
import { getRepositories } from '../../infrastructure/storage/index.ts'
import { maskSecret } from '../../utils/format.ts'
import type { ProviderConfig } from '../../config/provider-config.ts'

/**
 * Settings — AI report provider configuration.
 *
 * Engineering Bible §27/§28/§29/§31/§34 and Local MVP brief §11–§17.
 *
 * Basic mode asks for exactly two things: an API Key and a Model. Base URL, endpoint path,
 * temperature, timeout and transport are filled in from the preset and only appear once the user
 * opens 高级设置. That is the whole point of the preset file — "填 Key 就能用".
 */
export function SettingsPage() {
  const settings = useAppStore((state) => state.settings)
  const secretsSaved = useAppStore((state) => state.secretsSaved)
  const saveSettings = useAppStore((state) => state.saveSettings)
  const clearAllData = useAppStore((state) => state.clearAllData)

  const [apiKey, setApiKey] = useState(() => API_KEY_SESSION.get())
  const [remember, setRemember] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [diagnosis, setDiagnosis] = useState<ConnectionResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [wiped, setWiped] = useState(false)

  const provider = settings.provider
  const preset = useMemo(
    () => findPreset(provider.providerId) ?? findPreset(DEFAULT_PRESET_ID),
    [provider.providerId],
  )
  const isMock = isMockPreset(provider.providerId)

  const updateProvider = async (patch: Partial<ProviderConfig>) => {
    await saveSettings({ provider: { ...provider, ...patch } })
  }

  const handleSelectPreset = async (providerId: string) => {
    const found = findPreset(providerId)
    if (!found) return
    const applied = applyPreset(found, provider)
    setModels([])
    setDiagnosis(null)
    setStatusMessage(null)
    await saveSettings({ provider: applied.config })
    if (found.id === 'custom') setAdvanced(true)
  }

  const handleRememberToggle = async (next: boolean) => {
    setRemember(next)
    const repos = await getRepositories()
    if (next && apiKey.trim()) {
      await repos.settings.saveSecret(apiKey.trim())
      setStatusMessage('连接信息已保存在这台设备的浏览器数据中。')
    } else if (!next) {
      await repos.settings.clearSecret()
      setStatusMessage('已取消「记住此设备」，下次打开需要重新填写 Key。')
    }
  }

  const handleSaveKeyForSession = () => {
    API_KEY_SESSION.set(apiKey.trim())
    setStatusMessage(
      apiKey.trim()
        ? 'API Key 已保存在当前会话中，关闭浏览器后清除。'
        : '已清空当前会话中的 API Key。',
    )
  }

  /**
   * Persist the key when the field loses focus, WITHOUT touching any rendered state.
   *
   * This is deliberately silent. An earlier version also set a status message here, which
   * re-rendered the page at the exact moment a user (or an automated test) was tapping the next
   * control; the re-render swallowed the click and the button appeared to do nothing. A blur handler
   * must not change what is on screen, because it fires as a side effect of moving to the next
   * control rather than as a deliberate action.
   */
  const handleKeyBlur = () => {
    API_KEY_SESSION.set(apiKey.trim())
  }

  const handleTestConnection = async () => {
    setBusy(true)
    setDiagnosis(null)
    setStatusMessage(null)
    API_KEY_SESSION.set(apiKey.trim())
    try {
      const providerClient = createProvider(provider)
      const result = await providerClient.testConnection(provider, apiKey.trim())
      setDiagnosis(result)
      if (result.status === 'ok' && providerClient.listModels) {
        try {
          const list = await providerClient.listModels(provider, apiKey.trim())
          setModels(list)
          if (!provider.model && list[0]) await updateProvider({ model: list[0].id })
        } catch {
          // A provider may allow chat but not /models. The manual model field stays usable.
          setModels([])
        }
      }
    } catch (error) {
      setDiagnosis(classifyError(error, provider))
    } finally {
      setBusy(false)
    }
  }

  const handleClearAll = async () => {
    if (!window.confirm('这会删除本机上所有测评记录、结果、AI 报告与设置。确定吗？')) return
    await clearAllData()
    API_KEY_SESSION.clear()
    setApiKey('')
    setWiped(true)
  }

  return (
    <main className="page">
      <h1>AI 报告设置</h1>
      <p className="subtitle">
        这一步是可选的。不配置也能完成整个测评，只有「生成 AI 综合报告」需要它。
      </p>

      <section className="card">
        <h2>第一步：选择服务</h2>
        <label className="field">
          <span className="field-label">服务商</span>
          <select
            value={provider.providerId || DEFAULT_PRESET_ID}
            onChange={(event) => void handleSelectPreset(event.target.value)}
            data-testid="provider-select"
          >
            {PROVIDER_PRESETS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        {preset && (
          <p className="hint" data-testid="preset-note">
            {preset.note}
          </p>
        )}
        {presetWarnsAboutCors(preset) && (
          <div className="banner banner-warn" role="status">
            当前服务可能不允许浏览器直接连接。若测试连接提示跨域限制，请更换支持浏览器调用的兼容服务，或等待未来桌面版本的
            LocalBridge 支持。
          </div>
        )}
      </section>

      <section className="card">
        <h2>第二步：粘贴 API Key</h2>
        <label className="field">
          <span className="field-label">API Key</span>
          <input
            type="password"
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            placeholder={isMock ? '本地示例可随意填写占位值' : '粘贴你的 API Key'}
            onChange={(event) => setApiKey(event.target.value)}
            onBlur={handleKeyBlur}
            data-testid="api-key-input"
          />
        </label>
        <div className="actions">
          <button type="button" className="button small" onClick={handleSaveKeyForSession}>
            在本次会话中使用
          </button>
          {API_KEY_SESSION.has() && (
            <span className="hint" data-testid="key-session-state">
              当前会话已载入 Key：{maskSecret(API_KEY_SESSION.get())}
            </span>
          )}
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => void handleRememberToggle(event.target.checked)}
            data-testid="remember-device"
          />
          <span>记住此设备</span>
        </label>
        <p className="hint" data-testid="remember-note">
          连接信息将保存在当前设备的浏览器数据中，请仅在自己的设备上使用。
          {secretsSaved ? '（本机已保存一份）' : '（默认不保存，关闭页面即清除）'}
        </p>
      </section>

      <section className="card">
        <h2>第三步：选择模型</h2>
        {models.length > 0 ? (
          <label className="field">
            <span className="field-label">模型（来自服务返回的 /models）</span>
            <select
              value={provider.model}
              onChange={(event) => void updateProvider({ model: event.target.value })}
              data-testid="model-select"
            >
              <option value="">请选择</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="field">
            <span className="field-label">模型名称</span>
            <input
              type="text"
              value={provider.model}
              placeholder="例如 deepseek-chat"
              onChange={(event) => void updateProvider({ model: event.target.value })}
              data-testid="model-input"
            />
          </label>
        )}
        <p className="hint">
          测试连接成功后会自动尝试读取模型列表；如果服务不支持，就在这里手动填写。
        </p>
      </section>

      <section className="card">
        <h2>第四步：测试连接</h2>
        <div className="actions">
          <button
            type="button"
            className="button primary"
            onClick={() => void handleTestConnection()}
            disabled={busy}
            data-testid="test-connection"
          >
            {busy ? '正在测试…' : '测试连接'}
          </button>
          <button type="button" className="button" onClick={() => setAdvanced((value) => !value)}>
            {advanced ? '收起高级设置' : '展开高级设置'}
          </button>
        </div>

        {diagnosis && (
          <div
            className={diagnosis.status === 'ok' ? 'banner banner-ok' : 'banner banner-warn'}
            role="status"
            data-testid="connection-result"
          >
            <strong data-testid="connection-status">{STATUS_LABELS[diagnosis.status]}</strong>
            <span className="banner-detail">{diagnosis.message}</span>
            {diagnosis.suggestion && <span className="banner-detail">{diagnosis.suggestion}</span>}
            {diagnosis.technical && (
              <details className="technical">
                <summary>技术详情</summary>
                <pre className="error-detail">
                  {JSON.stringify(diagnosis.technical, null, 2)}
                  {'\n'}
                  (API Key 不会出现在这里)
                </pre>
              </details>
            )}
          </div>
        )}

        {statusMessage && (
          <p className="hint" data-testid="settings-message">
            {statusMessage}
          </p>
        )}
      </section>

      {advanced && (
        <section className="card" data-testid="advanced-settings">
          <h2>高级设置</h2>
          <p className="hint">
            普通使用不需要改这里。只有自建服务或需要调整超时、温度时才需要。Custom OpenAI-Compatible
            的流程是：填 Base URL → 填 Key → 测试连接 → 尝试读取 /models →
            成功则选模型，失败则手动填模型名。
          </p>

          <label className="field">
            <span className="field-label">Base URL</span>
            <input
              type="text"
              value={provider.baseURL}
              placeholder="https://api.example.com/v1"
              onChange={(event) => void updateProvider({ baseURL: event.target.value })}
              data-testid="base-url-input"
            />
          </label>

          <label className="field">
            <span className="field-label">传输方式</span>
            <select
              value={provider.transport}
              onChange={(event) =>
                void updateProvider({
                  transport: event.target.value as 'browser-direct' | 'local-bridge',
                })
              }
              data-testid="transport-select"
            >
              <option value="browser-direct">Browser Direct（当前可用）</option>
              <option value="local-bridge">Local Bridge（桌面版预留，当前不可用）</option>
            </select>
          </label>

          <label className="field">
            <span className="field-label">温度（0 - 1，越低越稳定）</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={provider.temperature}
              onChange={(event) => void updateProvider({ temperature: Number(event.target.value) })}
              data-testid="temperature-input"
            />
          </label>

          <label className="field">
            <span className="field-label">超时（毫秒）</span>
            <input
              type="number"
              min={5000}
              max={300000}
              step={1000}
              value={provider.timeoutMs}
              onChange={(event) => void updateProvider({ timeoutMs: Number(event.target.value) })}
              data-testid="timeout-input"
            />
          </label>

          <p className="hint">
            当前配置：{provider.providerId || '(未选)'} · {provider.baseURL || '(未填 Base URL)'} ·
            模型 {provider.model || '(未选)'} · 支持模型列表：
            {provider.supportsModelList ? '是' : '否'}
          </p>
        </section>
      )}

      <section className="card">
        <h2>本机数据</h2>
        <p className="hint">
          所有测评记录、结果与 AI
          报告都保存在这台设备的浏览器数据中。清除后无法恢复，也不会影响别处，因为本项目没有中心服务器。
        </p>
        <div className="actions">
          <button
            type="button"
            className="button danger"
            onClick={() => void handleClearAll()}
            data-testid="clear-all"
          >
            清除本机全部数据
          </button>
        </div>
        {wiped && (
          <p className="hint" data-testid="wiped-message">
            已清除本机数据。
          </p>
        )}
      </section>

      <div className="actions">
        <Link className="button" to="/">
          回首页
        </Link>
        <Link className="button" to="/history">
          历史记录
        </Link>
      </div>
    </main>
  )
}
