import { EventEmitter } from "node:events";

import type { Logger } from "../logger/logger.js";

/**
 * Every domain event and its payload. Modules add theirs with declaration merging:
 *
 *   declare module "../../../shared/events/event-bus.js" {
 *     interface DomainEvents { "user.registered": { userId: string } }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DomainEvents {}

type EventName = keyof DomainEvents & string;
type Listener<K extends EventName> = (payload: DomainEvents[K]) => void | Promise<void>;

/**
 * In-process domain events, so one module can react to another without importing it
 * (e.g. subscription reacts to "user.registered"). A failing listener is logged and
 * never breaks the request that emitted the event. Move to BullMQ when a listener must
 * survive a restart.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly logger: Logger) {}

  on<K extends EventName>(name: K, listener: Listener<K>): void {
    this.emitter.on(name, (payload: DomainEvents[K]) => {
      Promise.resolve()
        .then(() => listener(payload))
        .catch((err: unknown) => this.logger.error({ err, event: name }, "event listener failed"));
    });
  }

  emit<K extends EventName>(name: K, payload: DomainEvents[K]): void {
    this.emitter.emit(name, payload);
  }
}
