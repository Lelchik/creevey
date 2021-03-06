import cluster from 'cluster';
import { EventEmitter } from 'events';
import {
  Worker,
  Config,
  TestResult,
  BrowserConfig,
  WorkerMessage,
  TestStatus,
  isWorkerMessage,
  isTestMessage,
} from '../../types';
import { subscribeOn, sendTestMessage, sendShutdownMessage } from '../messages';

const FORK_RETRIES = 5;

type WorkerTest = { id: string; path: string[]; retries: number };

export default class Pool extends EventEmitter {
  private maxRetries: number;
  private config: BrowserConfig;
  private workers: Worker[] = [];
  private queue: WorkerTest[] = [];
  private forcedStop = false;
  private shuttingDown = false;
  public get isRunning(): boolean {
    return this.workers.length !== this.freeWorkers.length;
  }
  constructor(config: Config, private browser: string, private storybookBundle: string) {
    super();

    this.maxRetries = config.maxRetries;
    this.config = config.browsers[browser] as BrowserConfig;

    subscribeOn('shutdown', () => (this.shuttingDown = true));
  }

  async init(): Promise<void> {
    const poolSize = this.config.limit || 1;
    this.workers = (await Promise.all(Array.from({ length: poolSize }).map(() => this.forkWorker()))).filter(
      (workerOrError): workerOrError is Worker => workerOrError instanceof cluster.Worker,
    );
    if (this.workers.length != poolSize)
      throw new Error(`Can't instantiate workers for ${this.browser} due many errors`);
    this.workers.forEach((worker) => this.exitHandler(worker));
  }

  start(tests: { id: string; path: string[] }[]): boolean {
    if (this.isRunning) return false;

    this.queue = tests.map(({ id, path }) => ({ id, path, retries: 0 }));
    this.process();

    return true;
  }

  stop(): void {
    // TODO Timeout
    if (!this.isRunning) {
      // TODO this.emit("stop");
      return;
    }

    this.forcedStop = true;
    this.queue = [];
  }

  process(): void {
    const worker = this.getFreeWorker();
    const [test] = this.queue;

    if (this.queue.length == 0 && this.workers.length === this.freeWorkers.length) {
      this.forcedStop = false;
      this.emit('stop');
      return;
    }

    if (!worker || !test) return;

    worker.isRunning = true;

    const { id } = test;

    this.queue.shift();
    this.sendStatus({ id, status: 'running' });

    this.subscribe(worker, test);

    sendTestMessage(worker, { type: 'start', payload: test });

    this.process();
  }

  private sendStatus(message: { id: string; status: TestStatus; result?: TestResult }): void {
    this.emit('test', message);
  }

  private getFreeWorker(): Worker | undefined {
    return this.freeWorkers[Math.floor(Math.random() * this.freeWorkers.length)];
  }

  private get aliveWorkers(): Worker[] {
    return this.workers.filter((worker) => !worker.exitedAfterDisconnect);
  }

  private get freeWorkers(): Worker[] {
    return this.aliveWorkers.filter((worker) => !worker.isRunning);
  }

  private async forkWorker(retry = 0): Promise<Worker | { error: string }> {
    cluster.setupMaster({
      args: ['--browser', this.browser, '--storybookBundle', this.storybookBundle, ...process.argv.slice(2)],
    });
    const worker = cluster.fork();
    const message = await new Promise((resolve: (value: WorkerMessage) => void) => {
      const readyHandler = (message: unknown): void => {
        if (!isWorkerMessage(message)) return;
        worker.off('message', readyHandler);
        resolve(message);
      };
      worker.on('message', readyHandler);
    });

    if (message.type != 'error') return worker;

    this.gracefullyKill(worker);

    if (retry == FORK_RETRIES) return message.payload;
    return this.forkWorker(retry + 1);
  }

  private exitHandler(worker: Worker): void {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    worker.once('exit', async () => {
      if (this.shuttingDown) return;

      const workerOrError = await this.forkWorker();

      if (!(workerOrError instanceof cluster.Worker))
        throw new Error(`Can't instantiate worker for ${this.browser} due many errors`);

      this.exitHandler(workerOrError);
      this.workers[this.workers.indexOf(worker)] = workerOrError;
      this.process();
    });
  }

  private gracefullyKill(worker: Worker): void {
    const timeout = setTimeout(() => worker.kill(), 10000);
    worker.on('exit', () => clearTimeout(timeout));
    sendShutdownMessage(worker);
    worker.disconnect();
  }

  private shouldRetry(test: WorkerTest): boolean {
    return test.retries < this.maxRetries && !this.forcedStop;
  }

  private subscribe(worker: Worker, test: WorkerTest): void {
    worker.once('message', (message: unknown) => {
      if (!isWorkerMessage(message) && !isTestMessage(message)) return;
      if (message.type != 'end' && message.type != 'error') return;

      let result = null;

      if (message.type == 'error') {
        this.gracefullyKill(worker);

        result = { status: 'failed', ...(message.payload as { error: string }) } as TestResult;
      } else {
        result = message.payload as TestResult;
      }

      const shouldRetry = result.status == 'failed' && this.shouldRetry(test);

      if (shouldRetry) {
        test.retries += 1;
        this.queue.push(test);
      }

      worker.isRunning = false;

      this.sendStatus({ id: test.id, status: result.status, result });
      this.process();
    });
  }
}
