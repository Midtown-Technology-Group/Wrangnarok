export interface CliContext {
  readonly command: string;
  readonly [key: string]: unknown;
}

export function parseContext(argv?: string[]): CliContext;
export function runCommand(ctx: CliContext, deps?: Record<string, unknown>): Promise<any>;
