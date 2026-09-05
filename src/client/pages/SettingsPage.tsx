import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Database,
  Gauge,
  KeyRound,
  LockKeyhole,
  ServerCog,
  ShieldAlert
} from 'lucide-react';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { PageState } from '../components/PageState.js';
import type { HealthSnapshot } from '../api/client.js';
import { dataFromResource } from './pageSupport.js';

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
  ruleApproval: '大脑规则写入许可未批准',
  nativeWritePrimitives: '本地安全写入尚未启用',
  capabilityProfile: '本地写入能力尚未验证',
  recoveryKernel: '恢复功能尚未启用'
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

function indexDiagnostic(snapshot: HealthSnapshot): Diagnostic {
  switch (snapshot.index.status) {
    case 'ready': return { title: '本地索引', state: '已就绪', tone: 'green', icon: Gauge, details: [`版本 ${snapshot.index.version}`, `刷新于 ${snapshot.index.refreshedAt}`] };
    case 'stale': return { title: '本地索引', state: '待刷新', tone: 'amber', icon: Gauge, details: [`版本 ${snapshot.index.version}`, `最近成功 ${snapshot.index.lastSuccessAt}`] };
    case 'building': return { title: '本地索引', state: '构建中', tone: 'blue', icon: Gauge, details: [`版本 ${snapshot.index.version}`, `开始于 ${snapshot.index.startedAt}`] };
    case 'failed': return { title: '本地索引', state: '失败', tone: 'red', icon: Gauge, details: [`版本 ${snapshot.index.version}`, snapshot.index.lastSuccessAt === undefined ? '没有可用成功时间' : `最近成功 ${snapshot.index.lastSuccessAt}`] };
    case 'unavailable': return { title: '本地索引', state: '不可用', tone: 'red', icon: Gauge, details: ['读取索引当前不可用'] };
  }
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
    ...(snapshot.writeGate.reasonCode === 'RULE_BUNDLE_UNAPPROVED' ? ['当前大脑规则尚未批准写入'] : []),
    '当前阶段严格只读'
  ];
  return {
    title: '形式写入门',
    state: snapshot.writeGate.status === 'enabled' ? '写入门已通过' : '已阻断',
    tone: snapshot.writeGate.status === 'enabled' ? 'green' : 'red',
    icon: LockKeyhole,
    details
  };
}

function schemaDiagnostic(snapshot: HealthSnapshot): Diagnostic {
  if (snapshot.schemaIssues.status === 'available') {
    return {
      title: '结构检查', state: snapshot.schemaIssues.count === 0 ? '通过' : '需要处理',
      tone: snapshot.schemaIssues.count === 0 ? 'green' : 'amber', icon: ShieldAlert,
      details: [`${snapshot.schemaIssues.count} 个结构问题`], testId: 'schema-issue-count'
    };
  }
  return { title: '结构检查', state: '不可用', tone: 'silver', icon: Database, details: ['—'], testId: 'schema-issue-count' };
}

export function SettingsPage() {
  const runtime = useConsoleRuntime();
  const snapshot = dataFromResource(runtime.health);
  const desktop = window.xiaozhaoDesktop;
  const mountedRef = useRef(false);
  const [choosing, setChoosing] = useState(false);
  const [selectionMessage, setSelectionMessage] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const chooseVault = async (): Promise<void> => {
    if (desktop === undefined || choosing) return;
    setChoosing(true);
    setSelectionMessage('');
    try {
      const result = await desktop.chooseVaultDirectory();
      if (!mountedRef.current) return;
      setSelectionMessage(result.selected
        ? `已选择「${result.displayName ?? '大脑文件夹'}」，正在重新打开应用`
        : '已取消，继续使用当前大脑文件夹');
    } catch {
      if (mountedRef.current) setSelectionMessage('未能更换大脑文件夹，请重试');
    } finally {
      if (mountedRef.current) setChoosing(false);
    }
  };

  const diagnostics = snapshot === undefined ? [] : [
    vaultDiagnostic(snapshot),
    indexDiagnostic(snapshot),
    modelDiagnostic(snapshot),
    writeGateDiagnostic(snapshot),
    schemaDiagnostic(snapshot)
  ];

  return (
    <div className="settings-stack">
      <section className="settings-actions" aria-label="应用设置">
        <div className="settings-action">
          <div>
            <strong>大脑文件夹</strong>
            {desktop === undefined && <small>请在桌面 App 中更换大脑文件夹</small>}
          </div>
          <button className="quiet-button" type="button" disabled={desktop === undefined || choosing} onClick={() => void chooseVault()}>
            {choosing ? '正在选择…' : '更换大脑文件夹'}
          </button>
          {selectionMessage !== '' && <p className="settings-action__message" role="status">{selectionMessage}</p>}
        </div>
        <div className="settings-action">
          <div><strong>DeepSeek</strong><small>DeepSeek 设置将在后续阶段启用</small></div>
          <button className="quiet-button" type="button" disabled>配置 DeepSeek</button>
        </div>
      </section>
      {runtime.health.status === 'loading' && <PageState state={{ status: 'loading', message: '正在读取本地连接快照' }} />}
      {runtime.health.status === 'refreshing' && <PageState state={{ status: 'refreshing', message: '正在刷新诊断，上一份快照仍可查看' }} />}
      {runtime.health.status === 'failed' && <PageState state={runtime.health.state} />}
      {(runtime.health.status === 'failed' || runtime.health.status === 'refreshing') && (
        <button className="quiet-button settings-retry" type="button" disabled={runtime.health.status === 'refreshing'} onClick={() => void runtime.refreshHealth()}>
          {runtime.health.status === 'refreshing' ? '正在重新连接…' : '重新连接'}
        </button>
      )}
      <section className="diagnostic-grid" aria-label="系统连接诊断">
        {diagnostics.map(({ title, state, details, tone, icon: Icon, testId }) => (
          <article className={`diagnostic-row diagnostic-row--${tone}`} key={title}>
            <span className="diagnostic-row__icon"><Icon aria-hidden="true" /></span>
            <div><strong>{title}</strong>{details.map((detail, index) => <small key={`${detail}-${index}`} {...(testId === undefined || index !== 0 ? {} : { 'data-testid': testId })}>{detail}</small>)}</div>
            <span className="diagnostic-row__state"><i aria-hidden="true" />{state}</span>
          </article>
        ))}
      </section>
    </div>
  );
}
