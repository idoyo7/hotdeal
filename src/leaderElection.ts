import {
  KubeConfig,
  KubernetesObjectApi,
  V1Lease,
  V1MicroTime,
} from '@kubernetes/client-node';
import { logger } from './logger.js';

type LeaderElectionOptions = {
  enabled: boolean;
  leaseName: string;
  namespace: string;
  identity: string;
  leaseDurationSeconds: number;
  renewIntervalMs: number;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const toStatusCode = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const codeValue = Reflect.get(error, 'code');
  if (typeof codeValue === 'number') {
    return codeValue;
  }

  const statusCodeValue = Reflect.get(error, 'statusCode');
  if (typeof statusCodeValue === 'number') {
    return statusCodeValue;
  }

  const bodyValue = Reflect.get(error, 'body');
  if (typeof bodyValue === 'string') {
    try {
      const parsed = JSON.parse(bodyValue) as Record<string, unknown>;
      const bodyCode = parsed.code;
      if (typeof bodyCode === 'number') {
        return bodyCode;
      }
    } catch {
      return undefined;
    }
  }

  if (bodyValue && typeof bodyValue === 'object') {
    const codeValue = Reflect.get(bodyValue, 'code');
    if (typeof codeValue === 'number') {
      return codeValue;
    }
  }

  return undefined;
};

const toMicroTime = (value: Date): V1MicroTime => {
  const micro = new V1MicroTime();
  micro.setTime(value.getTime());
  return micro;
};

const toDate = (value: unknown): Date | undefined => {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export class LeaderElector {
  private readonly enabled: boolean;

  private readonly leaseName: string;

  private readonly namespace: string;

  private readonly identity: string;

  private readonly leaseDurationSeconds: number;

  private readonly renewIntervalMs: number;

  private api?: KubernetesObjectApi;

  private stopped = false;

  private renewLoop?: Promise<void>;

  private wakeRenewLoop?: () => void;

  private leader = false;

  private observedLeader = '';

  constructor(options: LeaderElectionOptions) {
    this.enabled = options.enabled;
    this.leaseName = options.leaseName;
    this.namespace = options.namespace;
    this.identity = options.identity;
    this.leaseDurationSeconds = Math.max(5, options.leaseDurationSeconds);
    this.renewIntervalMs = Math.max(1_000, options.renewIntervalMs);
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromDefault();
    this.api = KubernetesObjectApi.makeApiClient(kubeConfig);

    await this.tryAcquireOrRenew();
    this.renewLoop = this.startRenewLoop();
  }

  hasLeadership(): boolean {
    return this.leader;
  }

  async waitForLeadership(shouldStop: () => boolean = () => false): Promise<void> {
    if (!this.enabled) {
      return;
    }

    while (!this.stopped && !this.leader) {
      if (shouldStop()) {
        return;
      }

      await this.tryAcquireOrRenew();
      if (this.leader) {
        return;
      }
      await wait(this.renewIntervalMs);
    }
  }

  async close(options?: { releaseLease?: boolean }): Promise<void> {
    this.stopped = true;

    if (this.wakeRenewLoop) {
      this.wakeRenewLoop();
    }

    if (this.renewLoop) {
      await this.renewLoop;
    }

    if (options?.releaseLease && this.enabled) {
      try {
        await this.releaseLease();
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.error(`Leader election close failed while releasing lease (${reason})`, error);
      }
    }
  }

  private async startRenewLoop(): Promise<void> {
    while (!this.stopped) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.wakeRenewLoop = undefined;
          resolve();
        }, this.renewIntervalMs);

        this.wakeRenewLoop = () => {
          clearTimeout(timer);
          this.wakeRenewLoop = undefined;
          resolve();
        };
      });

      if (this.stopped) {
        return;
      }

      try {
        await this.tryAcquireOrRenew();
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        this.setLeaderState(false, this.observedLeader || 'unknown');
        logger.error(`Leader election renew failed (${reason})`, error);
      }
    }
  }

  private leaseHeader(): {
    apiVersion: string;
    kind: string;
    metadata: {
      name: string;
      namespace: string;
    };
  } {
    return {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: {
        name: this.leaseName,
        namespace: this.namespace,
      },
    };
  }

  private isLeaseExpired(lease: V1Lease, now: Date): boolean {
    const renewTime = toDate(lease.spec?.renewTime);
    if (!renewTime) {
      return true;
    }

    const renewalMs = renewTime.getTime();
    if (Number.isNaN(renewalMs)) {
      return true;
    }

    const leaseDurationSeconds = lease.spec?.leaseDurationSeconds ?? this.leaseDurationSeconds;
    return now.getTime() > renewalMs + leaseDurationSeconds * 1000;
  }

  private async createLease(now: Date): Promise<boolean> {
    if (!this.api) {
      return false;
    }

    const nowMicro = toMicroTime(now);
    const lease: V1Lease = {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: {
        name: this.leaseName,
        namespace: this.namespace,
      },
      spec: {
        holderIdentity: this.identity,
        leaseDurationSeconds: this.leaseDurationSeconds,
        acquireTime: nowMicro,
        renewTime: nowMicro,
        leaseTransitions: 0,
      },
    };

    try {
      await this.api.create(lease);
      this.setLeaderState(true, this.identity);
      return true;
    } catch (error: unknown) {
      const statusCode = toStatusCode(error);
      if (statusCode === 409) {
        return false;
      }
      throw error;
    }
  }

  private async tryAcquireOrRenew(): Promise<boolean> {
    if (!this.enabled || !this.api) {
      return true;
    }

    const now = new Date();
    let currentLease: V1Lease;

    try {
      currentLease = await this.api.read<V1Lease>(this.leaseHeader());
    } catch (error: unknown) {
      const statusCode = toStatusCode(error);
      if (statusCode === 404) {
        return this.createLease(now);
      }
      throw error;
    }

    const holderIdentity = currentLease.spec?.holderIdentity || '';
    const isMine = holderIdentity === this.identity;
    const expired = this.isLeaseExpired(currentLease, now);

    if (isMine || holderIdentity.length === 0 || expired) {
      const nowMicro = toMicroTime(now);
      const currentTransitions = currentLease.spec?.leaseTransitions ?? 0;
      const nextTransitions = isMine ? currentTransitions : currentTransitions + 1;
      const nextAcquireTime = isMine
        ? currentLease.spec?.acquireTime ?? nowMicro
        : nowMicro;

      const replacement: V1Lease = {
        ...currentLease,
        apiVersion: 'coordination.k8s.io/v1',
        kind: 'Lease',
        metadata: {
          ...currentLease.metadata,
          name: this.leaseName,
          namespace: this.namespace,
        },
        spec: {
          ...currentLease.spec,
          holderIdentity: this.identity,
          leaseDurationSeconds: this.leaseDurationSeconds,
          acquireTime: nextAcquireTime,
          renewTime: nowMicro,
          leaseTransitions: nextTransitions,
        },
      };

      try {
        await this.api.replace(replacement);
        this.setLeaderState(true, this.identity);
        return true;
      } catch (error: unknown) {
        const statusCode = toStatusCode(error);
        if (statusCode === 409) {
          this.setLeaderState(false, holderIdentity);
          return false;
        }
        throw error;
      }
    }

    this.setLeaderState(false, holderIdentity);
    return false;
  }

  private async releaseLease(): Promise<void> {
    if (!this.api) {
      return;
    }

    let currentLease: V1Lease;
    try {
      currentLease = await this.api.read<V1Lease>(this.leaseHeader());
    } catch (error: unknown) {
      const statusCode = toStatusCode(error);
      if (statusCode === 404) {
        return;
      }
      throw error;
    }

    if (currentLease.spec?.holderIdentity !== this.identity) {
      return;
    }

    const nowMicro = toMicroTime(new Date());
    const replacement: V1Lease = {
      ...currentLease,
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: {
        ...currentLease.metadata,
        name: this.leaseName,
        namespace: this.namespace,
      },
      spec: {
        ...currentLease.spec,
        holderIdentity: '',
        renewTime: nowMicro,
      },
    };

    try {
      await this.api.replace(replacement);
      this.setLeaderState(false, 'none');
      logger.info(`Leader election lease released (lease=${this.namespace}/${this.leaseName})`);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error(`Leader election lease release failed (${reason})`, error);
    }
  }

  private setLeaderState(isLeader: boolean, holderIdentity: string): void {
    const holder = holderIdentity || 'none';

    if (isLeader && !this.leader) {
      logger.info(
        `Leader election acquired (identity=${this.identity}, lease=${this.namespace}/${this.leaseName})`
      );
    }

    if (!isLeader && this.leader) {
      logger.info(
        `Leader election lost (current leader=${holder})`
      );
    }

    if (!isLeader && this.observedLeader !== holder) {
      logger.info(
        `Leader election standby (current leader=${holder})`
      );
      this.observedLeader = holder;
    }

    if (isLeader) {
      this.observedLeader = this.identity;
    }

    this.leader = isLeader;
  }
}
