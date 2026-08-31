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
  restartPersistence: '重启持久化能力未验证'
};

type Diagnostic = {
  readonly title: string;
  readonly state: string;
  readonly details: readonly string[];
  readonly tone: 'green' | 'blue' | 'amber' | 'red' | 'silver';
  readonly icon: typeof ServerCog;
  readonly testId?: string;
};

function pluginDiagnostic(snapshot: HealthSnapshot): Diagnostic {
  if (snapshot.plugin.status === 'connected') {
    return {
      title: 'Obsidian Local REST', state: '已连接', tone: 'green', icon: ServerCog,
      details: [`Obsidian ${snapshot.plugin.obsidianVersion}`, `插件 ${snapshot.plugin.pluginVersion}`]
    };
  }
  return { title: 'Obsidian Local REST', state: '不可用', tone: 'red', icon: ServerCog, details: ['本地插件未提供可用连接'] };
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
    'Phase 1 始终只读'
  ];
  return {
    title: '形式写入门',
    state: snapshot.writeGate.status === 'enabled' ? '能力已验证但未启用' : '已阻断',
    tone: snapshot.writeGate.status === 'enabled' ? 'amber' : 'red',
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

export function ConnectionsPage() {
  const runtime = useConsoleRuntime();
  const snapshot = dataFromResource(runtime.health);
  const diagnostics = snapshot === undefined ? [] : [
    pluginDiagnostic(snapshot),
    indexDiagnostic(snapshot),
    modelDiagnostic(snapshot),
    writeGateDiagnostic(snapshot),
    schemaDiagnostic(snapshot)
  ];

  if (snapshot === undefined) {
    if (runtime.health.status === 'failed') return <PageState state={runtime.health.state} />;
    return <PageState state={{ status: runtime.health.status === 'loading' ? 'loading' : 'refreshing', message: '正在读取本地连接快照' }} />;
  }

  return (
    <div className="connections-stack">
      {runtime.health.status === 'refreshing' && <PageState state={{ status: 'refreshing', message: '正在刷新诊断，上一份快照仍可查看' }} />}
      {runtime.health.status === 'failed' && <PageState state={runtime.health.state} />}
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
