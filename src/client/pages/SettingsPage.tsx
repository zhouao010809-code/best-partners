import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  ArrowUpRight,
  ChevronDown,
  FolderOpen,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  ServerCog,
  Settings2,
  ShieldAlert
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { PageState } from '../components/PageState.js';
import { DocumentIssuesPanel } from '../components/DocumentIssuesPanel.js';
import { DeepSeekSettings } from '../components/DeepSeekSettings.js';
import type { HealthSnapshot } from '../api/client.js';
import type { UpdateCheckResult } from '../../electron/update-check.js';
import { dataFromResource } from './pageSupport.js';
import '../styles/settings.css';

const KNOWN_MISSING: Readonly<Record<string, string>> = {
  WRITE_ENABLED: '未配置写入开关',
  writeEnabled: '未配置写入开关',
  profile: '缺少契约画像',
  profileKey: '契约画像密钥不匹配',
  database: '写入数据库不可用',
  recovery: '恢复目录不可用',
  safeRead: '安全读取能力未验证',
  safeCreate: '安全创建能力未验证',
  safeReplace: '安全替换能力未验证',
  safeRestore: '安全恢复能力未验证',
  safeDelete: '安全删除能力未验证',
  rereadVerified: '回读验证能力未验证',
  externalMutationObservation: '外部变更观测能力未验证',
  restartPersistence: '重启持久化能力未验证',
  ruleApproval: '通用接口的规则写入许可未批准',
  nativeWritePrimitives: '通用写入接口尚未启用',
  capabilityProfile: '通用接口能力尚未验证',
  recoveryKernel: '通用接口恢复模块尚未启用'
};

type Diagnostic = {
  readonly title: string;
  readonly state: string;
  readonly details: readonly string[];
  readonly tone: 'green' | 'blue' | 'amber' | 'red' | 'silver';
  readonly icon: typeof ServerCog;
  readonly testId?: string;
};

function vaultDiagnostic(snapshot: HealthSnapshot): Diagnostic {
  if (snapshot.vaultSource.status === 'ready') {
    return {
      title: '大脑文件夹', state: '已连接', tone: 'green', icon: ServerCog,
      details: [`${snapshot.vaultSource.adapter === 'filesystem' ? '本地文件' : 'Local REST'} · ${snapshot.vaultSource.displayName}`]
    };
  }
  return {
    title: '大脑文件夹', state: '不可用', tone: 'red', icon: ServerCog,
    details: [snapshot.vaultSource.reason === 'VAULT_RULES_MISSING' ? '缺少大脑规则，请选择完整的大脑文件夹' : '无法读取大脑文件夹，请重新选择']
  };
}

function indexSummary(snapshot: HealthSnapshot | undefined): string {
  if (snapshot === undefined) return '索引读取中';
  switch (snapshot.index.status) {
    case 'ready': return `索引 v${snapshot.index.version}`;
    case 'stale': return `索引 v${snapshot.index.version} · 待刷新`;
    case 'building': return `索引 v${snapshot.index.version} · 构建中`;
    case 'failed': return `索引 v${snapshot.index.version} · 失败`;
    case 'unavailable': return '索引不可用';
  }
}

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间不可用' : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function DiagnosticRow({ diagnostic }: { readonly diagnostic: Diagnostic }) {
  const { title, state, details, tone, icon: Icon, testId } = diagnostic;
  return <article className={`diagnostic-row diagnostic-row--${tone}`}>
    <span className="diagnostic-row__icon"><Icon aria-hidden="true" /></span>
    <div><strong>{title}</strong>{details.map((detail, index) => <small key={`${detail}-${index}`} {...(testId === undefined || index !== 0 ? {} : { 'data-testid': testId })}>{detail}</small>)}</div>
    <span className="diagnostic-row__state"><i aria-hidden="true" />{state}</span>
  </article>;
}

function modelDiagnostic(snapshot: HealthSnapshot): Diagnostic {
  switch (snapshot.model.status) {
    case 'configured': return { title: '模型配置', state: '已配置', tone: 'blue', icon: Bot, details: [snapshot.model.providerHost, snapshot.model.name] };
    case 'unconfigured': return { title: '模型配置', state: '未配置', tone: 'amber', icon: KeyRound, details: [snapshot.model.providerHost] };
    case 'unavailable': return { title: '模型配置', state: '不可用', tone: 'red', icon: KeyRound, details: ['模型配置当前不可读取'] };
  }
}

function writeGateDiagnostic(snapshot: HealthSnapshot): Diagnostic {
  const known = snapshot.writeGate.missing.flatMap((missing) => {
    const translated = KNOWN_MISSING[missing];
    return translated === undefined ? [] : [translated];
  });
  const unknownCount = snapshot.writeGate.missing.length - known.length;
  const details = [
    ...new Set(known),
    ...(unknownCount === 0 ? [] : [`其他阻断项 ${unknownCount} 项`]),
    snapshot.writeGate.fingerprintMatches ? '契约指纹一致' : '契约指纹不一致',
    ...(snapshot.writeGate.reasonCode === 'RULE_BUNDLE_UNAPPROVED' ? ['当前规则未批准旧通用接口写入'] : []),
    '此项仅诊断旧版通用接口；个人 App 的确认归档和候选入库使用独立入口，请在收件箱或提炼队列核对结果。'
  ];
  return {
    title: '旧版通用写入门',
    state: snapshot.writeGate.status === 'enabled' ? '写入门已通过' : '已阻断',
    tone: snapshot.writeGate.status === 'enabled' ? 'green' : 'silver',
    icon: LockKeyhole,
    details
  };
}

export function SettingsPage() {
  const runtime = useConsoleRuntime();
  const snapshot = dataFromResource(runtime.health);
  const desktop = window.xiaozhaoDesktop;
  const mountedRef = useRef(false);
  const [choosing, setChoosing] = useState(false);
  const [selectionMessage, setSelectionMessage] = useState('');
  const [vaultInfo, setVaultInfo] = useState<{ displayName: string; path: string }>();
  const [vaultInfoError, setVaultInfoError] = useState(false);
  const [locationRevision, setLocationRevision] = useState(0);
  const [appVersion, setAppVersion] = useState<string>();
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);
  const openPending = useRef(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const issuesButton = useRef<HTMLButtonElement>(null);
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'up-to-date' | 'available' | 'error'>('idle');
  const [updateResult, setUpdateResult] = useState<Extract<UpdateCheckResult, { status: 'available' }>>();
  const [updateDownloadError, setUpdateDownloadError] = useState(false);
  const updatePending = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setVaultInfoError(false);
    if (desktop?.getVaultInfo) {
      void desktop.getVaultInfo().then((info) => { if (!cancelled) setVaultInfo(info); })
        .catch(() => { if (!cancelled) setVaultInfoError(true); });
    }
    if (desktop?.getAppVersion) {
      void desktop.getAppVersion().then((version) => { if (!cancelled) setAppVersion(version); }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [desktop, locationRevision]);

  const openVault = async (): Promise<void> => {
    if (!desktop?.openVaultDirectory || openPending.current) return;
    openPending.current = true;
    setOpening(true);
    setOpenError(false);
    try { await desktop.openVaultDirectory(); }
    catch { if (mountedRef.current) setOpenError(true); }
    finally {
      openPending.current = false;
      if (mountedRef.current) setOpening(false);
    }
  };

  const chooseVault = async (): Promise<void> => {
    if (desktop === undefined || choosing) return;
    setChoosing(true);
    setSelectionMessage('');
    try {
      const result = await desktop.chooseVaultDirectory();
      if (!mountedRef.current) return;
      setSelectionMessage(result.selected
        ? `已选择「${result.displayName ?? '大脑文件夹'}」，正在重新打开应用`
        : result.reason === 'unchanged' ? '已在使用这个大脑，无需更换。'
          : result.reason === 'busy' ? '已有文件夹选择窗口，请先完成当前选择。'
            : '已取消，继续使用当前大脑文件夹');
    } catch {
      if (mountedRef.current) setSelectionMessage('未能更换大脑文件夹，请重试');
    } finally {
      if (mountedRef.current) setChoosing(false);
    }
  };

  const checkUpdates = async (): Promise<void> => {
    if (!desktop?.checkForUpdates || updatePending.current) return;
    updatePending.current = true;
    setUpdateState('checking');
    setUpdateDownloadError(false);
    try {
      const result = await desktop.checkForUpdates();
      if (!mountedRef.current) return;
      if (result.status === 'available') {
        setUpdateResult(result);
        setUpdateState('available');
      } else if (result.status === 'up-to-date') {
        setUpdateResult(undefined);
        setUpdateState('up-to-date');
      } else {
        setUpdateState('error');
      }
    } catch {
      if (mountedRef.current) setUpdateState('error');
    } finally {
      updatePending.current = false;
    }
  };

  const openUpdateLink = async (url: string): Promise<void> => {
    setUpdateDownloadError(false);
    try {
      if (desktop?.openUpdateDownload) await desktop.openUpdateDownload(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      if (mountedRef.current) setUpdateDownloadError(true);
    }
  };

  const openUpdateDownload = async (): Promise<void> => {
    if (updateResult) await openUpdateLink(updateResult.assetUrl);
  };

  const vault = snapshot === undefined ? undefined : vaultDiagnostic(snapshot);
  const issueCount = snapshot?.schemaIssues.status === 'available' ? snapshot.schemaIssues.count : undefined;
  const refreshing = runtime.health.status === 'refreshing';
  const healthFailed = runtime.health.status === 'failed';
  const showIssues = () => {
    setIssuesOpen(true);
    issuesButton.current?.scrollIntoView?.({ block: 'nearest' });
    issuesButton.current?.focus({ preventScroll: true });
  };

  return (
    <div className="settings-workspace">
      <div className="settings-layout">
        <header className="settings-overview" aria-label="设置概览">
          <div>
            <span className="settings-overview__eyebrow">本地应用设置</span>
            <p>管理大脑位置、AI 连接和应用版本</p>
          </div>
          <div className="settings-overview__meta">
            <span className={`settings-chip settings-chip--${healthFailed ? 'amber' : vault?.tone ?? 'silver'}`}>
              <i aria-hidden="true" />{healthFailed ? '连接待确认' : vault?.state ?? '读取中'}
            </span>
            <span className="settings-overview__version">{appVersion ? `版本 ${appVersion}` : '版本读取中'}</span>
          </div>
        </header>

        {issueCount !== undefined && issueCount > 0 && <div className="settings-issues-alert" role="status" aria-label="资料检查提醒">
          <ShieldAlert aria-hidden="true" />
          <span><strong>{issueCount} 项资料待确认</strong><small>部分资料信息缺失或分类不明确，不会被自动修改。</small></span>
          <button className="settings-text-link" type="button" onClick={showIssues}>查看待确认资料<ArrowUpRight aria-hidden="true" /></button>
        </div>}

        <div className="settings-primary-grid settings-preferences" aria-label="应用设置">
          <section className="settings-section settings-card settings-vault" aria-labelledby="settings-vault-heading">
            <header className="settings-section__heading">
              <div><h2 id="settings-vault-heading">大脑文件夹</h2><p>连接你的资料与知识</p></div>
              <span className={`settings-chip settings-chip--${healthFailed ? 'amber' : vault?.tone ?? 'silver'}`}>
                <i aria-hidden="true" />{healthFailed ? '连接待确认' : vault?.state ?? '读取中'}
              </span>
            </header>
            <div className="settings-section__body">
              <div className="settings-vault__current">
                <FolderOpen className="settings-vault__folder" aria-hidden="true" />
                <div className="settings-vault__identity">
                  <strong>{vaultInfo?.displayName ?? (snapshot?.vaultSource.status === 'ready' ? snapshot.vaultSource.displayName : healthFailed ? '未能读取当前大脑' : snapshot ? '尚未连接文件夹' : '正在读取…')}</strong>
                  <small>{snapshot?.vaultSource.status === 'ready'
                    ? snapshot.vaultSource.adapter === 'filesystem' ? '本地文件 · Obsidian 知识库' : 'Local REST · Obsidian 知识库'
                    : vault?.details[0] ?? (healthFailed ? '请重新连接本地服务' : '正在读取本地连接快照')}</small>
                </div>
              </div>
              <div className="settings-vault__location">
                {vaultInfo ? <p className="settings-vault__path" aria-label="当前大脑路径">{vaultInfo.path}</p>
                  : <p className="settings-vault__hint">{vaultInfoError ? '未能读取文件夹位置' : desktop?.getVaultInfo ? '正在读取文件夹位置…' : '文件夹位置可在最新版桌面 App 中查看。'}</p>}
                {vaultInfoError && <button type="button" className="settings-text-link" onClick={() => setLocationRevision((value) => value + 1)}>重新读取位置</button>}
              </div>
              <div className="settings-vault__actions">
                {desktop?.openVaultDirectory && <button className="settings-button" type="button" disabled={opening || choosing} onClick={() => void openVault()}><FolderOpen aria-hidden="true" />{opening ? '正在打开…' : '在 Finder 中打开'}</button>}
                <button className="settings-button settings-vault__change" type="button" disabled={desktop === undefined || choosing || opening} onClick={() => void chooseVault()}>
                  {choosing ? '正在选择…' : '更换大脑文件夹'}
                </button>
              </div>
              <p className="settings-vault__hint">{desktop === undefined ? '请在桌面 App 中更换大脑文件夹' : '切换会重新打开应用，正在进行的提炼会中断。原大脑的资料保留在原位置。'}</p>
              {openError && <p className="settings-feedback settings-feedback--error" role="alert">未能打开文件夹，请重试；也可按上方路径手动打开。</p>}
              {selectionMessage !== '' && <p className="settings-feedback" role="status">{selectionMessage}</p>}
            </div>
          </section>
          <DeepSeekSettings />
          <section className="settings-section settings-card settings-updates" aria-label="应用更新">
            <header className="settings-section__heading">
              <div><h2>应用更新</h2><p>手动检查桌面版是否有新版本</p></div>
            </header>
            <div className="settings-section__body">
              <p className="settings-updates__current">当前版本 {appVersion ?? '读取中'}</p>
              {desktop?.checkForUpdates ? <>
                <div className="settings-updates__actions">
                  <button type="button" className="settings-button" disabled={updateState === 'checking'} onClick={() => void checkUpdates()}>
                    {updateState === 'checking' ? '正在检查…' : updateState === 'error' ? '重试检查' : '检查应用更新'}
                  </button>
                </div>
                {updateState === 'checking' && <p className="settings-feedback" role="status">正在检查应用更新…</p>}
                {updateState === 'up-to-date' && <p className="settings-feedback" role="status">已是最新版本</p>}
                {updateState === 'error' && <p className="settings-feedback settings-feedback--error" role="alert">暂时无法检查应用更新，请稍后重试。</p>}
                {updateState === 'available' && updateResult && <div className="settings-updates__result" role="status">
                  <p className="settings-updates__version">发现新版本 {updateResult.version}</p>
                  <p className="settings-updates__meta">当前版本 {updateResult.currentVersion}{updateResult.publishedAt ? ` · 发布于 ${displayTime(updateResult.publishedAt)}` : ''}</p>
                  <p className="settings-updates__notes">{updateResult.notes}</p>
                  <div className="settings-updates__actions">
                    <button type="button" className="settings-button settings-button--primary" onClick={() => void openUpdateDownload()}>打开下载页面</button>
                    {updateResult.releaseUrl && (desktop?.openUpdateDownload
                      ? <button type="button" className="settings-button settings-button--quiet" onClick={() => void openUpdateLink(updateResult.releaseUrl)}>查看 Release 页面</button>
                      : <a className="settings-button settings-button--quiet" href={updateResult.releaseUrl} target="_blank" rel="noopener noreferrer">查看 Release 页面</a>)}
                  </div>
                  {updateDownloadError && <p className="settings-feedback settings-feedback--error" role="alert">未能打开下载页面，请复制 Release 页面地址后重试。</p>}
                </div>}
              </> : <p className="settings-feedback" role="status">桌面版可用，浏览器预览不会检查应用更新。</p>}
            </div>
          </section>
        </div>

        <aside className="settings-health-summary settings-health" aria-label="运行状态摘要">
          <header className="settings-health-summary__heading settings-health__heading">
            <div><h2>运行状态</h2></div>
            <Link className="settings-text-link settings-health__history" to="/operations">操作与恢复<ArrowUpRight aria-hidden="true" /></Link>
            <button className={`settings-icon-button${refreshing ? ' is-refreshing' : ''}`} type="button" aria-label={healthFailed ? '重新连接' : '刷新运行状态'} title={healthFailed ? '重新连接' : '刷新运行状态'} disabled={refreshing || runtime.health.status === 'loading'} onClick={() => void runtime.refreshHealth()}><RefreshCw aria-hidden="true" /></button>
          </header>
          {runtime.health.status === 'failed' && <PageState state={runtime.health.state} />}
          <div className="settings-health-summary__items" role="status">
            <span>{healthFailed ? '本地连接待确认' : snapshot === undefined ? '本地连接读取中' : '本地连接正常'}</span>
            <span>{indexSummary(snapshot)}</span>
            <span data-testid="schema-issue-count">{snapshot === undefined ? '结构检查待进行' : snapshot.schemaIssues.status === 'available' ? `${snapshot.schemaIssues.count} 个结构问题` : '—'}</span>
          </div>
        </aside>
      </div>

      <div className="settings-support">
        <section className={`settings-disclosure${issuesOpen ? ' is-open' : ''}`} aria-label="资料检查详情">
          <h2><button ref={issuesButton} type="button" className="settings-disclosure__button" aria-expanded={issuesOpen} aria-controls="settings-document-issues" onClick={() => setIssuesOpen(!issuesOpen)}>
            <ShieldAlert aria-hidden="true" /><span><strong>待确认资料</strong><small>查看资料信息缺失或分类不明确的文件</small></span>
            <span className={`settings-chip settings-chip--${issueCount ? 'amber' : 'silver'}`}>{issueCount === undefined ? '待检查' : issueCount === 0 ? '无待处理' : `${issueCount} 项待确认`}</span><ChevronDown className="settings-disclosure__chevron" aria-hidden="true" />
          </button></h2>
          <div id="settings-document-issues" hidden={!issuesOpen}>{issuesOpen && <DocumentIssuesPanel />}</div>
        </section>
        <section className={`settings-disclosure${diagnosticsOpen ? ' is-open' : ''}`} aria-label="高级诊断详情">
          <h2><button type="button" className="settings-disclosure__button" aria-expanded={diagnosticsOpen} aria-controls="settings-advanced" onClick={() => setDiagnosticsOpen(!diagnosticsOpen)}>
            <Settings2 aria-hidden="true" /><span><strong>高级诊断</strong><small>连接信息与旧版接口的兼容状态</small></span><ChevronDown className="settings-disclosure__chevron" aria-hidden="true" />
          </button></h2>
          <div id="settings-advanced" hidden={!diagnosticsOpen}>
            {snapshot === undefined ? <p className="settings-advanced-empty">连接大脑后，即可查看详细诊断。</p> : <div className="settings-advanced-rows">{[vaultDiagnostic(snapshot), modelDiagnostic(snapshot), writeGateDiagnostic(snapshot)].map((diagnostic) => <DiagnosticRow key={diagnostic.title} diagnostic={diagnostic} />)}</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
