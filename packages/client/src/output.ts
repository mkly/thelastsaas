export interface OutputOptions {
  json?: boolean;
}

export function writeOutput(
  value: unknown,
  options: OutputOptions = {},
  human?: string,
): void {
  if (options.json || human === undefined) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(human);
}
