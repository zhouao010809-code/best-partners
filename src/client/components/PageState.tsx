import type { ComponentType } from 'react';
import {
  CircleCheck,
  CircleX,
  Clock3,
  GitCompareArrows,
  Inbox,
  LifeBuoy,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  WifiOff
} from 'lucide-react';

type StateFields = {
  readonly message?: string;
};

export type PageStateValue =
  | ({ readonly status: 'loading' } & StateFields)
  | ({ readonly status: 'empty' } & StateFields)
  | ({ readonly status: 'refreshing' } & StateFields)
  | ({ readonly status: 'disconnected' } & StateFields)
  | ({ readonly status: 'validation-error' } & StateFields)
  | ({ readonly status: 'operation-error' } & StateFields)
  | ({ readonly status: 'busy' } & StateFields)
  | ({ readonly status: 'success' } & StateFields)
  | ({ readonly status: 'conflict' } & StateFields)
  | ({ readonly status: 'recovery-required' } & StateFields);

type PageStateStatus = PageStateValue['status'];

type StateConfiguration = {
  readonly label: string;
  readonly fallbackMessage: string;
  readonly icon: ComponentType<{
    readonly className?: string;
    readonly role?: string;
    readonly 'aria-label'?: string;
    readonly 'aria-hidden'?: boolean;
  }>;
  readonly tone: 'neutral' | 'green' | 'blue' | 'amber' | 'red';
  readonly role: 'status' | 'alert';
  readonly busy: boolean;
};

const STATE_CONFIGURATION: Record<PageStateStatus, StateConfiguration> = {
  loading: {
    label: '正在加载',
    fallbackMessage: '正在读取本地数据。',
    icon: LoaderCircle,
    tone: 'neutral',
    role: 'status',
    busy: true
  },
  empty: {
    label: '暂无数据',
    fallbackMessage: '当前范围内没有可显示的记录。',
    icon: Inbox,
    tone: 'neutral',
    role: 'status',
    busy: false
  },
  refreshing: {
    label: '正在刷新',
    fallbackMessage: '已有数据仍可查看，新索引正在生成。',
    icon: RefreshCw,
    tone: 'blue',
    role: 'status',
    busy: true
  },
  disconnected: {
    label: '连接已断开',
    fallbackMessage: '无法连接本地服务，请检查运行状态。',
    icon: WifiOff,
    tone: 'red',
    role: 'alert',
    busy: false
  },
  'validation-error': {
    label: '数据校验失败',
    fallbackMessage: '服务返回的结构与当前客户端不兼容。',
    icon: ShieldAlert,
    tone: 'red',
    role: 'alert',
    busy: false
  },
  'operation-error': {
    label: '操作失败',
    fallbackMessage: '本次请求未完成，请根据操作编号追踪。',
    icon: CircleX,
    tone: 'red',
    role: 'alert',
    busy: false
  },
  busy: {
    label: '系统繁忙',
    fallbackMessage: '已有一项互斥任务正在执行。',
    icon: Clock3,
    tone: 'amber',
    role: 'status',
    busy: true
  },
  success: {
    label: '操作成功',
    fallbackMessage: '本次操作已完成。',
    icon: CircleCheck,
    tone: 'green',
    role: 'status',
    busy: false
  },
  conflict: {
    label: '版本冲突',
    fallbackMessage: '源文件已变化，请刷新后重新确认。',
    icon: GitCompareArrows,
    tone: 'amber',
    role: 'alert',
    busy: false
  },
  'recovery-required': {
    label: '需要恢复',
    fallbackMessage: '系统处于恢复模式，业务接口暂不可用。',
    icon: LifeBuoy,
    tone: 'blue',
    role: 'alert',
    busy: false
  }
};

export interface PageStateProps {
  readonly state: PageStateValue;
}

export function PageState({ state }: PageStateProps) {
  const configuration = STATE_CONFIGURATION[state.status];
  const Icon = configuration.icon;

  return (
    <section
      className={`page-state page-state--${configuration.tone}`}
      role={configuration.role}
      aria-live={configuration.role === 'alert' ? 'assertive' : 'polite'}
      aria-atomic="true"
      data-busy={configuration.busy ? 'true' : undefined}
    >
      <span className="page-state__icon">
        <Icon role="img" aria-label={`${configuration.label}图标`} />
      </span>
      <span className="page-state__copy">
        <strong>{configuration.label}</strong>
        <span>{state.message ?? configuration.fallbackMessage}</span>
      </span>
    </section>
  );
}
