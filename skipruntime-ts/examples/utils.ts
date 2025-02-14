// TODO: Remove once global `EventSource` makes it out of experimental
// in nodejs LTS.
import EventSource from "eventsource";
import type { Json, Entry } from "@skipruntime/core";
import { SkipServiceBroker } from "@skipruntime/helpers";
import { createInterface } from "readline";

export interface ClientDefinition {
  port: number;
  scenarios: () => Step[][];
}

interface Write {
  collection: string;
  entries: Entry<Json, Json>[];
}

interface Delete {
  collection: string;
  keys: string[];
}

export class SkipHttpAccessV1 {
  private service: SkipServiceBroker;

  constructor(
    private readonly streaming_port: number = 8080,
    control_port: number = 8081,
  ) {
    this.service = new SkipServiceBroker({
      host: "localhost",
      control_port,
      streaming_port,
    });
  }

  async writeMany(data: Write[]) {
    const promises = data.map(async (w) =>
      this.service.update(w.collection, w.entries),
    );
    if (promises.length == 1) {
      return promises[0];
    }
    return Promise.allSettled(promises);
  }

  async deleteMany(data: Delete[]) {
    const promises: Promise<void>[] = [];
    for (const x of data) {
      for (const key of x.keys) {
        promises.push(this.service.deleteKey(x.collection, key));
      }
    }
    if (promises.length == 1) {
      return promises[0];
    }
    return Promise.allSettled(promises);
  }

  async log(resource: string, params: Json) {
    const result = await this.service.getAll(resource, params);
    console.log(JSON.stringify(result));
  }

  request(resource: string, params: Json) {
    this.service
      .getStreamUUID(resource, params)
      .then((uuid) => {
        const evSource = new EventSource(
          `http://localhost:${this.streaming_port}/v1/streams/${uuid}`,
        );
        evSource.addEventListener("init", (e: MessageEvent<string>) => {
          const updates = JSON.parse(e.data);
          console.log("Init", updates);
        });
        evSource.addEventListener("update", (e: MessageEvent<string>) => {
          const updates = JSON.parse(e.data);
          console.log("Update", updates);
        });
        evSource.onerror = (e: MessageEvent<string>) => {
          console.log("Error", e);
        };
      })
      .catch((e: unknown) => {
        console.log(e);
      });
  }
}

interface RequestQuery {
  type: "request";
  payload: {
    resource: string;
    params?: Json;
    port?: number;
  };
}

interface LogQuery {
  type: "log";
  payload: {
    resource: string;
    params?: Json;
    port?: number;
  };
}

interface WriteQuery {
  type: "write";
  payload: Write[];
}

interface DeleteQuery {
  type: "delete";
  payload: Delete[];
}

export type Step = RequestQuery | LogQuery | WriteQuery | DeleteQuery;

class Session {
  current = 0;
  on = false;

  constructor(
    private readonly scenario: Step[],
    private readonly perform: (l: Step) => void,
    private readonly error: (e: string) => void,
  ) {}

  next(): boolean {
    if (this.current >= this.scenario.length) {
      this.error("The scenario as no more entries.");
      return false;
    }
    const step = this.scenario[this.current++]!; // checked by preceding if
    console.log(">>", step.type, JSON.stringify(step.payload));
    this.perform(step);
    return this.current < this.scenario.length;
  }

  play(): void {
    this.on = this.current < this.scenario.length;
    while (this.on) {
      this.on = this.next();
    }
  }

  pause(): void {
    this.on = false;
  }

  reset(): void {
    this.on = false;
    this.current = 0;
  }
}

class Player {
  running?: Session;

  constructor(
    private readonly scenarios: Step[][],
    private readonly perform: (l: string) => void,
    private readonly send: (l: Step) => void,
    private readonly error: (e: string) => void,
  ) {}

  start(idx: number) {
    const aidx = idx - 1;
    if (aidx < 0 || aidx >= this.scenarios.length) {
      this.error(`The scenario ${idx.toString()} does not exist`);
      return false;
    } else {
      const scenario = this.scenarios[aidx]!; // checked by enclosing if
      this.running = new Session(scenario, this.send, this.error);
      return true;
    }
  }

  play(idx?: number) {
    let run = true;
    if (idx !== undefined) {
      run = this.start(idx);
    }
    if (run) {
      if (this.running) {
        this.running.play();
      } else {
        this.error(`No current scenario session`);
      }
    }
  }

  step(idx?: number) {
    const running = this.running;
    if (!running) {
      this.error(`No current scenario session`);
      return;
    }
    let steps = Math.min(idx ?? 1, 1);
    while (steps > 0) {
      if (!running.next()) {
        break;
      }
      steps--;
    }
  }

  reset() {
    const running = this.running;
    if (running) running.reset();
  }

  stop() {
    this.running = undefined;
  }

  online(line: string) {
    if (line.trim().length == 0 && this.running) {
      this.step();
      return;
    }
    const patterns: [RegExp, (...args: string[]) => unknown][] = [
      [
        /^start ([a-z_0-9]+)$/g,
        (str: string) => {
          this.start(parseInt(str));
        },
      ],
      [
        /^reset$/g,
        () => {
          this.reset();
        },
      ],
      [
        /^step ([a-z_0-9]+)$/g,
        (str: string) => {
          this.step(parseInt(str));
        },
      ],
      [
        /^step$/g,
        () => {
          this.step();
        },
      ],
      [
        /^play ([a-z_0-9]+)$/g,
        (str: string) => {
          this.play(parseInt(str));
        },
      ],
      [
        /^play$/g,
        () => {
          this.play();
        },
      ],
      [
        /^stop$/g,
        () => {
          this.stop();
        },
      ],
    ];
    let done = false;
    for (const pattern of patterns) {
      const matches = [...line.matchAll(pattern[0])];
      if (matches.length > 0) {
        done = true;
        const args = matches[0]!.map((v) => v.toString()); // each match is nonempty
        args.shift();
        pattern[1].apply(null, args);
      }
    }
    if (!done) this.perform(line);
  }
}
/**
 * Run the client with specified scenarios
 * @param scenarios The scenarios
 * @param streaming_port  Port of the streaming server
 * @param control_port  Port of the control server
 */
export function run(
  scenarios: Step[][],
  streaming_port: number = 8080,
  control_port: number = 8081,
) {
  const access = new SkipHttpAccessV1(streaming_port, control_port);
  const online = (line: string) => {
    if (line == "exit") {
      return;
    }
    try {
      const patterns: [RegExp, (...args: string[]) => void][] = [
        [
          /^request (.*)$/g,
          (query: string) => {
            const jsquery = JSON.parse(query) as {
              resource: string;
              params?: Json;
            };
            access.request(jsquery.resource, jsquery.params ?? {});
          },
        ],
        [
          /^log (.*)$/g,
          (query: string) => {
            const jsquery = JSON.parse(query) as {
              resource: string;
              params?: Json;
            };
            access
              .log(jsquery.resource, jsquery.params ?? {})
              .catch((e: unknown) => {
                console.error(e);
              });
          },
        ],
        [
          /^write (.*)$/g,
          (query: string) => {
            const jsquery = JSON.parse(query) as Write[];
            access
              .writeMany(jsquery)
              .then(console.log)
              .catch((e: unknown) => {
                console.error(e);
              });
          },
        ],
        [
          /^delete (.*)$/g,
          (query: string) => {
            const jsquery = JSON.parse(query) as Delete[];
            access
              .deleteMany(jsquery)
              .then(console.log)
              .catch((e: unknown) => {
                console.error(e);
              });
          },
        ],
      ];
      let done = false;
      for (const pattern of patterns) {
        const matches = [...line.matchAll(pattern[0])];
        if (matches.length > 0) {
          done = true;
          const args = matches[0]!.map((v) => v.toString()); // each match is nonempty
          args.shift();
          pattern[1].apply(null, args);
        }
      }
      if (!done) {
        console.error(`Unknown command line '${line}'`);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : JSON.stringify(e);
      console.error(message);
    }
  };
  const player = new Player(
    scenarios,
    online,
    (step) => {
      if (step.type == "request") {
        access.request(step.payload.resource, step.payload.params ?? {});
      } else if (step.type == "write") {
        access
          .writeMany(step.payload)
          .then(console.log)
          .catch((e: unknown) => {
            console.error(e);
          });
      } else if (step.type == "log") {
        access
          .log(step.payload.resource, step.payload.params ?? {})
          .catch((e: unknown) => {
            console.error(e);
          });
      } else {
        access
          .deleteMany(step.payload)
          .then(console.log)
          .catch((e: unknown) => {
            console.error(e);
          });
      }
    },
    console.error,
  );
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });
  rl.prompt();
  rl.on("line", (line: string) => {
    if (line == "exit") {
      process.exit(0);
    } else {
      player.online(line);
      rl.prompt();
    }
  });
}
